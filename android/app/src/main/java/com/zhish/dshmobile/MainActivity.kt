package com.zhish.dshmobile

import android.Manifest
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import com.zhish.dshmobile.ui.theme.DSHMobileTheme
import java.util.concurrent.Executors

private data class PairingUiState(
    val busy: Boolean = false,
    val status: String? = null,
    val error: String? = null,
)

class MainActivity : ComponentActivity() {
    private val worker = Executors.newSingleThreadExecutor()
    private var ui by mutableStateOf(PairingUiState())

    private val cameraPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) launchScanner() else ui = ui.copy(error = "需要相机权限才能扫描二维码。你也可以手工粘贴配对码。")
    }

    private val barcodeScanner = registerForActivityResult(ScanContract()) { result ->
        result.contents?.let(::pair)
    }

    private val remoteActivity = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode == RESULT_OK) MobileAppSession.clearLocal()
        ui = PairingUiState()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        configureScreenSecurity()
        MobileAppSession.initialize(applicationContext)
        enableEdgeToEdge()
        setContent {
            DSHMobileTheme(darkTheme = false, dynamicColor = false) {
                PairingScreen(
                    state = ui,
                    onScan = ::scan,
                    onPair = ::pair,
                    onErrorConsumed = { ui = ui.copy(error = null) },
                )
            }
        }
        restoreSessionIfAvailable()
    }

    override fun onDestroy() {
        worker.shutdownNow()
        super.onDestroy()
    }

    private fun configureScreenSecurity() {
        val debug = applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0
        if (debug) window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
        else window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
    }

    private fun restoreSessionIfAvailable() {
        if (MobileAppSession.current() == null) return
        ui = PairingUiState(busy = true, status = "正在恢复已配对设备…")
        worker.execute {
            val restored = MobileAppSession.restore()
            runOnUiThread {
                if (isFinishing || isDestroyed) return@runOnUiThread
                if (restored == null) ui = PairingUiState(error = "上次配对已失效，请重新扫描二维码。")
                else openRemote()
            }
        }
    }

    private fun scan() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) launchScanner()
        else cameraPermission.launch(Manifest.permission.CAMERA)
    }

    private fun launchScanner() {
        barcodeScanner.launch(
            ScanOptions().apply {
                setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                setPrompt("将电脑上的 DSH 配对二维码置于取景框内")
                setBeepEnabled(false)
                setOrientationLocked(false)
                setBarcodeImageEnabled(false)
            },
        )
    }

    private fun pair(raw: String) {
        val pairing = try {
            PairingUriParser.parse(raw)
        } catch (error: PairingUriException) {
            ui = ui.copy(error = error.message)
            return
        }
        ui = PairingUiState(busy = true, status = "正在建立安全连接…")
        worker.execute {
            try {
                MobileAppSession.connect(pairing)
                runOnUiThread {
                    if (!isFinishing && !isDestroyed) openRemote()
                }
            } catch (error: Exception) {
                runOnUiThread {
                    if (!isFinishing && !isDestroyed) ui = PairingUiState(error = error.message ?: "配对失败，请稍后重试。")
                }
            }
        }
    }

    private fun openRemote() {
        ui = PairingUiState()
        remoteActivity.launch(Intent(this, RemoteActivity::class.java))
    }
}

@Composable
private fun PairingScreen(
    state: PairingUiState,
    onScan: () -> Unit,
    onPair: (String) -> Unit,
    onErrorConsumed: () -> Unit,
) {
    val snackbars = remember { SnackbarHostState() }
    var manualUri by remember { mutableStateOf("") }
    var showManual by remember { mutableStateOf(false) }
    LaunchedEffect(state.error) {
        state.error?.let {
            snackbars.showSnackbar(it)
            onErrorConsumed()
        }
    }

    val dark = false
    val pageTop = if (dark) Color(0xFF171A21) else Color(0xFFF7F8FA)
    val pageBottom = if (dark) Color(0xFF0E0F12) else Color(0xFFEEF2F7)
    val secondaryText = if (dark) Color(0xFFB8BAC2) else Color(0xFF525B69)
    val quietText = if (dark) Color(0xFF8F929B) else Color(0xFF68717F)
    val secureBackground = if (dark) Color(0xFF1E2924) else Color(0xFFE5F4EB)
    val secureBorder = if (dark) Color(0xFF365748) else Color(0xFF9BC8AC)
    val secureText = if (dark) Color(0xFF83D6A5) else Color(0xFF246B43)
    val cardBackground = if (dark) Color(0xFF1B1C20) else Color.White
    val cardBorder = if (dark) Color(0x24FFFFFF) else Color(0x220C1524)
    val background = Brush.verticalGradient(listOf(pageTop, pageBottom))
    Scaffold(containerColor = Color.Transparent, snackbarHost = { SnackbarHost(snackbars) }) { padding ->
        Box(Modifier.fillMaxSize().background(background).padding(padding)) {
            Column(
                modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 22.dp, vertical = 18.dp),
                verticalArrangement = Arrangement.Center,
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("deepseek", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                    Spacer(Modifier.width(7.dp))
                    Surface(shape = RoundedCornerShape(3.dp), border = BorderStroke(1.dp, Color(0xFFC9CAD0)), color = Color.Transparent) {
                        Text("HARNESS", modifier = Modifier.padding(horizontal = 5.dp, vertical = 2.dp), style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold)
                    }
                    Spacer(Modifier.weight(1f))
                    Surface(shape = RoundedCornerShape(99.dp), color = secureBackground, border = BorderStroke(1.dp, secureBorder)) {
                        Text("● 本地安全连接", modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp), color = secureText, style = MaterialTheme.typography.labelSmall)
                    }
                }

                Spacer(Modifier.height(54.dp))
                Text("把 Harness\n带到手机上", style = MaterialTheme.typography.displaySmall, fontWeight = FontWeight.SemiBold, lineHeight = MaterialTheme.typography.displaySmall.lineHeight * 0.95f)
                Spacer(Modifier.height(16.dp))
                Text("扫码连接电脑上的 DeepSeek Harness，随时查看会话、发送任务并接收实时输出。", color = secondaryText, style = MaterialTheme.typography.bodyLarge)

                Spacer(Modifier.height(28.dp))
                Surface(shape = RoundedCornerShape(18.dp), color = cardBackground, border = BorderStroke(1.dp, cardBorder)) {
                    Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(13.dp)) {
                        FeatureLine("01", "一次扫码", "二维码短时且仅可使用一次")
                        FeatureLine("02", "最长保持 7 天", "系统回收 App 后仍可自动恢复")
                        FeatureLine("03", "权限保持受限", "不开放桌面凭据和文件管理")
                    }
                }

                Spacer(Modifier.height(24.dp))
                Button(
                    onClick = onScan,
                    enabled = !state.busy,
                    modifier = Modifier.fillMaxWidth().height(56.dp),
                    shape = RoundedCornerShape(16.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.primary, contentColor = MaterialTheme.colorScheme.onPrimary),
                ) {
                    Text("扫描电脑二维码", fontWeight = FontWeight.Bold)
                }

                TextButton(onClick = { showManual = !showManual }, enabled = !state.busy, modifier = Modifier.align(Alignment.CenterHorizontally)) {
                    Text(if (showManual) "收起手工配对" else "无法扫码？手工输入配对码", color = quietText)
                }
                if (showManual) {
                    OutlinedTextField(
                        value = manualUri,
                        onValueChange = { manualUri = it },
                        modifier = Modifier.fillMaxWidth(),
                        enabled = !state.busy,
                        label = { Text("dshmobile://pair?server=…&token=…") },
                        minLines = 3,
                        maxLines = 5,
                    )
                    Spacer(Modifier.height(10.dp))
                    Button(onClick = { onPair(manualUri) }, enabled = !state.busy && manualUri.isNotBlank(), modifier = Modifier.fillMaxWidth()) {
                        Text("使用配对码")
                    }
                }

                Spacer(Modifier.height(20.dp))
                Text("仅接受 HTTPS · 会话由 Android Keystore 加密保存", modifier = Modifier.fillMaxWidth(), color = quietText, style = MaterialTheme.typography.labelSmall, textAlign = TextAlign.Center)
            }

            if (state.busy) {
                Surface(modifier = Modifier.fillMaxSize(), color = if (dark) Color(0xE8121316) else Color(0xE8F7F8FA)) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                        CircularProgressIndicator(color = MaterialTheme.colorScheme.primary)
                        Spacer(Modifier.height(16.dp))
                        Text(state.status ?: "正在连接…", color = MaterialTheme.colorScheme.onSurface)
                    }
                }
            }
        }
    }
}

@Composable
private fun FeatureLine(number: String, title: String, detail: String) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Surface(shape = RoundedCornerShape(99.dp), color = MaterialTheme.colorScheme.secondaryContainer) {
            Text(number, modifier = Modifier.padding(horizontal = 9.dp, vertical = 5.dp), color = MaterialTheme.colorScheme.onSecondaryContainer, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold)
        }
        Spacer(Modifier.width(12.dp))
        Column {
            Text(title, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.bodyMedium)
            Text(detail, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
        }
    }
}
