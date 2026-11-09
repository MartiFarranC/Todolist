package cat.martifarran.ara

import android.content.Context

/** Mateix projecte de Supabase que la web (web/config.js). */
const val SUPABASE_URL = "https://mjdbqbcyensvyvhzegrc.supabase.co"

/** Petites dades locals: testimoni de Firebase, clau del widget i l'últim text del widget. */
object Prefs {
    private fun sp(c: Context) = c.getSharedPreferences("ara", Context.MODE_PRIVATE)

    fun fcmToken(c: Context): String? = sp(c).getString("fcm_token", null)
    fun setFcmToken(c: Context, token: String) = sp(c).edit().putString("fcm_token", token).apply()

    fun widgetKey(c: Context): String? = sp(c).getString("widget_key", null)
    fun setWidgetKey(c: Context, key: String) = sp(c).edit().putString("widget_key", key).apply()

    fun widgetText(c: Context): String? = sp(c).getString("widget_text", null)
    fun widgetSub(c: Context): String = sp(c).getString("widget_sub", null).orEmpty()
    fun setWidget(c: Context, text: String, sub: String) =
        sp(c).edit().putString("widget_text", text).putString("widget_sub", sub).apply()

    fun askedNotifications(c: Context): Boolean = sp(c).getBoolean("asked_notifications", false)
    fun setAskedNotifications(c: Context) = sp(c).edit().putBoolean("asked_notifications", true).apply()
}
