plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Release version comes from the Nuvio TV release tag (build-apk.sh passes -PversionName=1.4.1).
val appVersionName = (findProperty("versionName") as String?) ?: "1.0.0"
val appVersionCode = appVersionName.split('.', '-').mapNotNull { it.toIntOrNull() }.let { parts ->
    val (major, minor, patch) = (parts + listOf(0, 0, 0)).take(3)
    major * 1_000_000 + minor * 1_000 + patch
}

android {
    namespace = "space.nuvio.webtvinstaller"
    compileSdk = 36

    defaultConfig {
        applicationId = "space.nuvio.webtvinstaller"
        minSdk = 26
        targetSdk = 36
        versionCode = appVersionCode
        versionName = appVersionName
    }

    signingConfigs {
        create("release") {
            // Stable release key from the environment (CI secrets); see build-apk.sh.
            System.getenv("NUVIO_ANDROID_KEYSTORE")?.let { storeFile = file(it) }
            storePassword = System.getenv("NUVIO_ANDROID_KEYSTORE_PASSWORD")
            keyAlias = System.getenv("NUVIO_ANDROID_KEY_ALIAS")
            keyPassword = System.getenv("NUVIO_ANDROID_KEY_PASSWORD")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = if (System.getenv("NUVIO_ANDROID_KEYSTORE") != null) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    packaging {
        resources.excludes += setOf("META-INF/versions/9/OSGI-INF/MANIFEST.MF")
    }
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-ktx:1.11.0")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("com.github.mwiede:jsch:2.28.8")
}
