package cat.martifarran.ara

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewAssetLoader
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import org.json.JSONObject

/**
 * L'app: la interfície de web/ (empaquetada dins l'APK) en un WebView,
 * amb avisos, widget i dreceres natius. La web parla amb Android amb window.AraNative.
 */
class MainActivity : ComponentActivity() {

    private lateinit var web: WebView
    private var pageReady = false
    private var pendingQuery: String? = null

    private val askNotifications =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            callJs("window.araOnPermission && araOnPermission($granted)")
        }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)

        if ((applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true) // chrome://inspect
        }

        val root = FrameLayout(this).apply { setBackgroundColor(ContextCompat.getColor(context, R.color.bg)) }
        web = WebView(this).apply { setBackgroundColor(ContextCompat.getColor(context, R.color.bg)) }
        root.addView(web, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        setContentView(root)

        // Pantalla de vora a vora: deixar lloc a la barra d'estat, la de navegació i el teclat.
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val b = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime() or
                    WindowInsetsCompat.Type.displayCutout()
            )
            v.setPadding(b.left, b.top, b.right, b.bottom)
            WindowInsetsCompat.CONSUMED
        }

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true // la sessió de Supabase es desa a localStorage
            allowFileAccess = false
            allowContentAccess = false
        }
        val assets = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                assets.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.url.host == WebViewAssetLoader.DEFAULT_DOMAIN) return false
                // Enllaços de fora: al navegador
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, request.url)) }
                return true
            }

            override fun onPageFinished(view: WebView, url: String?) {
                pageReady = true
                pendingQuery?.let { deliver(it) }
                pendingQuery = null
            }
        }
        web.addJavascriptInterface(Bridge(), "AraNative")

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                web.evaluateJavascript("(window.araBack && araBack()) === true") { handled ->
                    if (handled != "true") moveTaskToBack(true)
                }
            }
        })

        dismissNotification(intent)
        val query = queryOf(intent)
        web.loadUrl(START_URL + (query?.let { "?$it" } ?: ""))
        fetchFcmToken()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        dismissNotification(intent)
        val query = queryOf(intent) ?: return
        if (pageReady) deliver(query) else pendingQuery = query
    }

    override fun onResume() {
        super.onResume()
        web.onResume()
    }

    override fun onPause() {
        web.onPause()
        super.onPause()
    }

    override fun onStop() {
        super.onStop()
        WidgetWorker.refreshNow(this)
    }

    // ---------- Ajudes ----------

    private fun queryOf(i: Intent?): String? =
        i?.data?.takeIf { it.scheme == "ara" }?.encodedQuery?.takeIf { it.isNotBlank() }

    private fun deliver(query: String) =
        callJs("window.araIntent && araIntent(${JSONObject.quote(query)})")

    private fun callJs(js: String) = runOnUiThread { web.evaluateJavascript(js, null) }

    private fun dismissNotification(i: Intent?) {
        val id = i?.getIntExtra(Notifier.EXTRA_NOTIFICATION_ID, 0) ?: 0
        if (id != 0) NotificationManagerCompat.from(this).cancel(id)
    }

    private fun fetchFcmToken() {
        if (FirebaseApp.getApps(this).isEmpty()) return // falta google-services.json
        FirebaseMessaging.getInstance().token.addOnSuccessListener { token ->
            if (token.isNullOrBlank()) return@addOnSuccessListener
            Prefs.setFcmToken(this, token)
            if (pageReady) callJs("window.araOnToken && araOnToken()")
        }
    }

    private fun requestNotifications() {
        if (NotificationManagerCompat.from(this).areNotificationsEnabled()) {
            callJs("window.araOnPermission && araOnPermission(true)")
            return
        }
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED &&
            !Prefs.askedNotifications(this)
        ) {
            Prefs.setAskedNotifications(this)
            askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
            return
        }
        // Ja s'havia dit que no: obrir els ajustos d'avisos de l'app.
        startActivity(
            Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
        )
    }

    /** window.AraNative: el que la web pot demanar a Android. */
    inner class Bridge {
        @JavascriptInterface
        fun fcmToken(): String = Prefs.fcmToken(this@MainActivity).orEmpty()

        @JavascriptInterface
        fun deviceName(): String = "Android · ${Build.MODEL}"

        @JavascriptInterface
        fun notificationsEnabled(): Boolean = NotificationManagerCompat.from(this@MainActivity).areNotificationsEnabled()

        @JavascriptInterface
        fun requestNotifications() = runOnUiThread { this@MainActivity.requestNotifications() }

        @JavascriptInterface
        fun setWidgetKey(key: String) {
            if (key.isNotBlank()) Prefs.setWidgetKey(this@MainActivity, key)
        }

        @JavascriptInterface
        fun refreshWidget() = WidgetWorker.refreshNow(this@MainActivity)
    }

    companion object {
        private const val START_URL = "https://${WebViewAssetLoader.DEFAULT_DOMAIN}/assets/index.html"
    }
}
