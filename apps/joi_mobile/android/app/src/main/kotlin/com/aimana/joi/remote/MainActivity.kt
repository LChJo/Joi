package com.aimana.joi.remote

import android.content.Context
import android.os.Bundle
import io.flutter.embedding.android.FlutterActivity

class MainActivity : FlutterActivity() {
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
