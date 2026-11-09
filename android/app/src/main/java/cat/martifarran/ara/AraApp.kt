package cat.martifarran.ara

import android.app.Application

class AraApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Notifier.createChannels(this)
    }
}
