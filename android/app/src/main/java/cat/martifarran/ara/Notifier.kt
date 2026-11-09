package cat.martifarran.ara

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

/**
 * Avisos. Un canal per nivell, perquè el Martí pugui ajustar-los des dels ajustos d'Android:
 * - normal: sense so · important: so i a dalt de la pantalla · digest (resum del matí): so
 * - urgent: es queda fins que el toques i pot saltar el No molestar (si ho permets al canal)
 */
object Notifier {
    const val NORMAL = "normal"
    const val IMPORTANT = "important"
    const val DIGEST = "digest"
    const val URGENT = "urgent"
    const val EXTRA_NOTIFICATION_ID = "notification_id"

    fun createChannels(c: Context) {
        val nm = c.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannels(listOf(
            NotificationChannel(NORMAL, c.getString(R.string.channel_normal), NotificationManager.IMPORTANCE_LOW).apply {
                description = c.getString(R.string.channel_normal_desc)
            },
            NotificationChannel(IMPORTANT, c.getString(R.string.channel_important), NotificationManager.IMPORTANCE_HIGH).apply {
                description = c.getString(R.string.channel_important_desc)
            },
            NotificationChannel(DIGEST, c.getString(R.string.channel_digest), NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = c.getString(R.string.channel_digest_desc)
            },
            NotificationChannel(URGENT, c.getString(R.string.channel_urgent), NotificationManager.IMPORTANCE_HIGH).apply {
                description = c.getString(R.string.channel_urgent_desc)
                setBypassDnd(true)
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            },
        ))
    }

    @SuppressLint("MissingPermission") // es comprova just abans
    fun show(c: Context, data: Map<String, String>) {
        val nm = NotificationManagerCompat.from(c)
        if (!nm.areNotificationsEnabled()) return
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(c, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return

        val level = data["level"]?.takeIf { it in setOf(NORMAL, IMPORTANT, DIGEST, URGENT) } ?: NORMAL
        val title = data["title"].orEmpty().ifBlank { "Ara" }
        val body = data["body"].orEmpty()
        val taskId = data["task_id"]?.takeIf { it.isNotBlank() }
        // El mateix tag substitueix l'avís anterior en lloc d'acumular-ne.
        val id = (data["tag"]?.takeIf { it.isNotBlank() } ?: "$title|$body").hashCode() and 0x0fffffff

        val b = NotificationCompat.Builder(c, level)
            .setSmallIcon(R.drawable.ic_stat_ara)
            .setColor(ContextCompat.getColor(c, R.color.icon_bg))
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setContentIntent(open(c, id, taskId, "open", 0))
            .setCategory(if (level == URGENT) NotificationCompat.CATEGORY_ALARM else NotificationCompat.CATEGORY_REMINDER)
            .setPriority(
                when (level) {
                    NORMAL -> NotificationCompat.PRIORITY_LOW
                    DIGEST -> NotificationCompat.PRIORITY_DEFAULT
                    else -> NotificationCompat.PRIORITY_HIGH
                }
            )
        if (taskId != null) {
            b.addAction(0, c.getString(R.string.action_done), open(c, id, taskId, "done", 1))
            b.addAction(0, c.getString(R.string.action_later), open(c, id, taskId, "later", 2))
        }
        if (level == URGENT) b.setOngoing(true)
        nm.notify(id, b.build())
    }

    /** Obre l'app amb ara://open?task=<id>&do=<acció>; l'app fa l'acció i treu l'avís. */
    private fun open(c: Context, id: Int, taskId: String?, action: String, n: Int): PendingIntent {
        val uri = if (taskId == null) "ara://open" else "ara://open?task=${Uri.encode(taskId)}&do=$action"
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(uri), c, MainActivity::class.java)
            .putExtra(EXTRA_NOTIFICATION_ID, id)
        return PendingIntent.getActivity(
            c, id * 3 + n, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }
}
