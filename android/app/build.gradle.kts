plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Firebase (avisos) només s'activa si hi ha app/google-services.json (vegeu README).
// Sense el fitxer l'app compila igual, però no rep avisos.
if (file("google-services.json").exists()) {
    apply(plugin = "com.google.gms.google-services")
}

android {
    namespace = "cat.martifarran.ara"
    compileSdk = 35

    defaultConfig {
        applicationId = "cat.martifarran.ara"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // Per instal·lar-la al teu mòbil n'hi ha prou amb la clau de depuració.
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    // La interfície és la web de la carpeta web/ del repo, empaquetada dins l'app.
    sourceSets["main"].assets.srcDir(rootProject.file("../web"))

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.work:work-runtime-ktx:2.10.0")
    implementation(platform("com.google.firebase:firebase-bom:33.7.0"))
    implementation("com.google.firebase:firebase-messaging")
}
