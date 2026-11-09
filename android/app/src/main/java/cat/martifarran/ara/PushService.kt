package cat.martifarran.ara

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/** Rep els avisos de Supabase (funció todo-push) a través de Firebase. */
class PushService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        // La web el desa a Supabase el pròxim cop que s'obri l'app.
        Prefs.setFcmToken(this, token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data.toMutableMap()
        message.notification?.let { n ->
            if (data["title"].isNullOrBlank()) data["title"] = n.title.orEmpty()
            if (data["body"].isNullOrBlank()) data["body"] = n.body.orEmpty()
        }
        Notifier.show(this, data)
        WidgetWorker.refreshNow(this)
    }
}
