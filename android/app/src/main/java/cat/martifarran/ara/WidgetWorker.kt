package cat.martifarran.ara

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

/** Llegeix la tasca d'ara (todo-push?widget=<widget_key>, només lectura) i repinta el widget. */
class WidgetWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val c = applicationContext
        val key = Prefs.widgetKey(c) ?: return@withContext Result.success()
        val url = URL("$SUPABASE_URL/functions/v1/todo-push?widget=${URLEncoder.encode(key, "UTF-8")}")
        val conn = url.openConnection() as HttpURLConnection
        try {
            conn.connectTimeout = 10_000
            conn.readTimeout = 10_000
            when (conn.responseCode) {
                200 -> {
                    val j = JSONObject(conn.inputStream.bufferedReader().use { it.readText() })
                    Prefs.setWidget(c, j.str("text").ifBlank { "Res pendent. Descansa." }, j.str("sub"))
                    NowWidget.updateAll(c)
                    Result.success()
                }
                401 -> Result.success() // clau incorrecta: no insistir
                else -> Result.retry()
            }
        } catch (e: Exception) {
            Result.retry()
        } finally {
            conn.disconnect()
        }
    }

    private fun JSONObject.str(name: String): String = if (isNull(name)) "" else optString(name)

    companion object {
        private const val NOW = "widget-now"
        private const val PERIODIC = "widget-periodic"
        private val online = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

        /** Actualitza ara (només si hi ha algun widget a la pantalla d'inici). */
        fun refreshNow(c: Context) {
            if (!NowWidget.hasWidgets(c) || Prefs.widgetKey(c) == null) return
            schedule(c)
            WorkManager.getInstance(c).enqueueUniqueWork(
                NOW, ExistingWorkPolicy.REPLACE,
                OneTimeWorkRequestBuilder<WidgetWorker>().setConstraints(online).build()
            )
        }

        /** Cada 15 min (el mínim d'Android), perquè canviï sol quan comença o acaba una rutina. */
        fun schedule(c: Context) {
            WorkManager.getInstance(c).enqueueUniquePeriodicWork(
                PERIODIC, ExistingPeriodicWorkPolicy.KEEP,
                PeriodicWorkRequestBuilder<WidgetWorker>(15, TimeUnit.MINUTES).setConstraints(online).build()
            )
        }

        fun cancel(c: Context) {
            WorkManager.getInstance(c).cancelUniqueWork(PERIODIC)
        }
    }
}
