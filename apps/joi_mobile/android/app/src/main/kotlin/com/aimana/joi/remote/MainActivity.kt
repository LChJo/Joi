package com.aimana.joi.remote

import android.content.Context
import android.os.Bundle
import android.content.Intent
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import io.flutter.embedding.android.FlutterActivity

class MainActivity : FlutterActivity() {
    private var exports: ResultExportBridge? = null
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        exports = ResultExportBridge(this)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "joi/result-export").setMethodCallHandler(exports)
    }
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (exports?.onActivityResult(requestCode, resultCode, data) != true) super.onActivityResult(requestCode, resultCode, data)
    }
    companion object {
        init {
            System.loadLibrary("joi_remote")
        }
    }

    private external fun initializeNativeRemote(context: Context)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        initializeNativeRemote(applicationContext)
    }
}
