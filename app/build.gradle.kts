import java.net.URI
import javax.inject.Inject

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.example.pdfannotation"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.example.pdfannotation"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // Example app: sign release builds with the debug key so the APK is installable.
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    androidResources {
        // pdf.js loads these at runtime; keep them uncompressed for faster reads.
        noCompress += listOf("mjs", "bcmap", "pfb", "ttf", "wasm", "icc")
    }
}

dependencies {
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.12.1")
}

/**
 * Downloads the pdfjs-dist package from npm and extracts the pieces the viewer needs
 * (legacy build, worker, cmaps, standard fonts, wasm decoders, ICC profiles) into a
 * generated assets directory, served in the app at /assets/pdfjs/.
 */
abstract class PreparePdfjsAssets : DefaultTask() {
    @get:Input
    abstract val version: Property<String>

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @get:Inject
    abstract val fs: FileSystemOperations

    @get:Inject
    abstract val archives: ArchiveOperations

    @TaskAction
    fun prepare() {
        val v = version.get()
        val tarball = File(temporaryDir, "pdfjs-dist-$v.tgz")
        if (!tarball.exists()) {
            val partial = File(temporaryDir, "${tarball.name}.part")
            URI("https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-$v.tgz").toURL().openStream().use { input ->
                partial.outputStream().use { input.copyTo(it) }
            }
            partial.renameTo(tarball)
        }
        fs.sync {
            from(archives.tarTree(tarball)) {
                include(
                    "package/LICENSE",
                    "package/legacy/build/pdf.min.mjs",
                    "package/legacy/build/pdf.worker.min.mjs",
                    "package/cmaps/**",
                    "package/standard_fonts/**",
                    "package/wasm/**",
                    "package/iccs/**",
                )
                eachFile { path = path.removePrefix("package/").replace("legacy/build/", "build/") }
            }
            into(outputDir.dir("pdfjs"))
            includeEmptyDirs = false
        }
    }
}

val preparePdfjsAssets = tasks.register<PreparePdfjsAssets>("preparePdfjsAssets") {
    version.set(providers.gradleProperty("pdfjsVersion"))
    outputDir.set(layout.buildDirectory.dir("generated/pdfjs-assets"))
}

androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(preparePdfjsAssets, PreparePdfjsAssets::outputDir)
    }
}
