package cat.martifarran.ara

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.view.View
import android.widget.RemoteViews

/**
 * Widget de la pantalla d'inici: la tasca d'ara i el primer pas
 * (o la rutina en curs i fins a quina hora). Tocar-lo obre l'app.
 */
class NowWidget : AppWidgetProvider() {

    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        render(context, manager, ids)
        // Només programar (no executar aquí): evita un bucle conegut entre WorkManager i els widgets.
        WidgetWorker.schedule(context)
    }

    override fun onEnabled(context: Context) {
        WidgetWorker.schedule(context)
    }

    override fun onDisabled(context: Context) {
        WidgetWorker.cancel(context)
    }

    companion object {
        private fun ids(c: Context): IntArray =
            AppWidgetManager.getInstance(c).getAppWidgetIds(ComponentName(c, NowWidget::class.java))

        fun hasWidgets(c: Context) = ids(c).isNotEmpty()

        fun updateAll(c: Context) {
            val ids = ids(c)
            if (ids.isNotEmpty()) render(c, AppWidgetManager.getInstance(c), ids)
        }

        private fun render(c: Context, manager: AppWidgetManager, ids: IntArray) {
            val views = RemoteViews(c.packageName, R.layout.widget_now)
            val text = Prefs.widgetText(c)
            val sub = Prefs.widgetSub(c)
            views.setTextViewText(R.id.widget_text, text ?: c.getString(R.string.widget_empty))
            views.setTextViewText(R.id.widget_sub, sub)
            views.setViewVisibility(R.id.widget_sub, if (text != null && sub.isNotBlank()) View.VISIBLE else View.GONE)
            val open = PendingIntent.getActivity(
                c, 0, Intent(c, MainActivity::class.java),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            views.setOnClickPendingIntent(R.id.widget_root, open)
            manager.updateAppWidget(ids, views)
        }
    }
}
