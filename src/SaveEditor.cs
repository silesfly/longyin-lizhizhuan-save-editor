using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace LongYinSaveEditor
{
    internal static class Program
    {
        private const string RuntimeVersion = "runtime-1.0.0";
        private const string LoaderResourceName = "WebView2Loader.dll";

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool SetDllDirectory(string lpPathName);

        [STAThread]
        private static int Main(string[] args)
        {
            string selfTestOutDir = null;
            string selfTestSeedPath = null;
            bool selfTestMode = false;

            if (args != null)
            {
                for (int i = 0; i < args.Length; i++)
                {
                    if (string.Equals(args[i], "--self-test", StringComparison.OrdinalIgnoreCase))
                    {
                        selfTestMode = true;
                        if (i + 1 < args.Length && !args[i + 1].StartsWith("-", StringComparison.Ordinal))
                        {
                            selfTestOutDir = args[i + 1];
                            i++;
                        }
                        if (i + 1 < args.Length && !args[i + 1].StartsWith("-", StringComparison.Ordinal))
                        {
                            selfTestSeedPath = args[i + 1];
                            i++;
                        }
                    }
                }
            }

            if (selfTestMode && string.IsNullOrEmpty(selfTestOutDir))
            {
                selfTestOutDir = Path.Combine(Path.GetTempPath(), "LongYinSaveEditorSelfTest");
            }

            try
            {
                string runtimeDir = EnsureWebView2Runtime();
                SetDllDirectory(runtimeDir);
            }
            catch
            {
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            EditorForm form = new EditorForm(selfTestMode, selfTestOutDir, selfTestSeedPath);
            Application.Run(form);

            if (selfTestMode && !File.Exists(Path.Combine(selfTestOutDir, "receipt.json")))
            {
                return 1;
            }
            return 0;
        }

        private static string EnsureWebView2Runtime()
        {
            string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            if (string.IsNullOrEmpty(localAppData))
            {
                localAppData = Path.GetTempPath();
            }

            string runtimeDir = Path.Combine(localAppData, "LongYinSaveEditor", RuntimeVersion);
            Directory.CreateDirectory(runtimeDir);

            string targetPath = Path.Combine(runtimeDir, LoaderResourceName);
            if (File.Exists(targetPath) && new FileInfo(targetPath).Length > 0)
            {
                return runtimeDir;
            }

            string basePath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, LoaderResourceName);
            if (File.Exists(basePath))
            {
                File.Copy(basePath, targetPath, true);
                return runtimeDir;
            }

            Assembly asm = Assembly.GetExecutingAssembly();
            using (Stream stream = asm.GetManifestResourceStream(LoaderResourceName))
            {
                if (stream != null)
                {
                    using (FileStream output = new FileStream(targetPath, FileMode.Create, FileAccess.Write, FileShare.Read))
                    {
                        stream.CopyTo(output);
                    }
                }
            }

            return runtimeDir;
        }
    }

    public sealed class EditorForm : Form
    {
        public const string EditorVirtualUrl = "https://lyz.local/editor.html";
        private const string HtmlResourceName = "editor.html";

        private readonly bool _selfTestMode;
        private readonly string _selfTestOutDir;
        private readonly string _selfTestSeedPath;
        private readonly JavaScriptSerializer _serializer;

        private readonly WebView2 _webView;
        private string _currentRootDir;
        private string _html;
        private bool _navigationBlocked;
        private bool _senderGuardVerified;
        private bool _selfTestStarted;
        private bool _webViewInitialized;

        public EditorForm(bool selfTestMode, string selfTestOutDir, string selfTestSeedPath)
        {
            _selfTestMode = selfTestMode;
            _selfTestOutDir = selfTestOutDir;
            _selfTestSeedPath = selfTestSeedPath;
            _serializer = SaveStore.CreateSerializer();

            Text = "용윤입지전 세이브 에디터 v1.0.0";
            Width = 1220;
            Height = 840;
            MinimumSize = new Size(880, 620);
            StartPosition = FormStartPosition.CenterScreen;

            if (_selfTestMode)
            {
                ShowInTaskbar = false;
                WindowState = FormWindowState.Minimized;
                StartPosition = FormStartPosition.Manual;
                Location = new Point(-32000, -32000);
                Opacity = 0;

                string seedDir = Path.Combine(_selfTestOutDir, "seed");
                Directory.CreateDirectory(seedDir);
                _currentRootDir = seedDir;
            }
            else
            {
                string defaultSaveDir = SaveStore.GetDefaultSaveDirectory();
                string defaultBackupDir = SaveStore.GetDefaultBackupSaveDirectory();
                _currentRootDir = Directory.Exists(defaultSaveDir) ? defaultSaveDir : defaultBackupDir;
            }

            _webView = new WebView2();
            _webView.Dock = DockStyle.Fill;
            Controls.Add(_webView);

            Shown += EditorForm_Shown;
        }

        private async void EditorForm_Shown(object sender, EventArgs e)
        {
            if (_webViewInitialized)
            {
                return;
            }
            _webViewInitialized = true;

            try
            {
                _html = LoadHtmlResource();

                string userDataDir = _selfTestMode
                    ? Path.Combine(_selfTestOutDir, "wv2-profile")
                    : Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                        "LongYinSaveEditor", "wv2-profile");
                Directory.CreateDirectory(userDataDir);

                CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(null, userDataDir, null);
                await _webView.EnsureCoreWebView2Async(env);

                CoreWebView2 core = _webView.CoreWebView2;
                CoreWebView2Settings settings = core.Settings;
                settings.AreDevToolsEnabled = false;
                settings.AreDefaultContextMenusEnabled = false;
                settings.AreHostObjectsAllowed = false;
                settings.IsStatusBarEnabled = false;
                settings.IsBuiltInErrorPageEnabled = false;

                core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
                core.WebResourceRequested += CoreWebView2_WebResourceRequested;
                core.NavigationStarting += CoreWebView2_NavigationStarting;
                core.FrameNavigationStarting += CoreWebView2_FrameNavigationStarting;
                core.NewWindowRequested += delegate(object nwSender, CoreWebView2NewWindowRequestedEventArgs nwArgs)
                {
                    nwArgs.Handled = true;
                };
                core.WebMessageReceived += CoreWebView2_WebMessageReceived;
                core.NavigationCompleted += CoreWebView2_NavigationCompleted;

                await core.AddScriptToExecuteOnDocumentCreatedAsync(BuildBridgeScript());
                core.Navigate(EditorVirtualUrl);
            }
            catch (Exception ex)
            {
                if (_selfTestMode)
                {
                    WriteSelfTestFailureReceipt("WebView2 initialization failed: " + ex.Message);
                    Application.Exit();
                }
                else
                {
                    MessageBox.Show("WebView2 초기화에 실패했습니다:\n" + ex.Message,
                        "용윤입지전 세이브 에디터", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    Close();
                }
            }
        }

        private static string LoadHtmlResource()
        {
            Assembly asm = Assembly.GetExecutingAssembly();
            using (Stream stream = asm.GetManifestResourceStream(HtmlResourceName))
            {
                if (stream == null)
                {
                    throw new InvalidOperationException("Embedded resource editor.html was not found.");
                }
                using (StreamReader reader = new StreamReader(stream, Encoding.UTF8, true))
                {
                    return reader.ReadToEnd();
                }
            }
        }

        private void CoreWebView2_WebResourceRequested(object sender, CoreWebView2WebResourceRequestedEventArgs e)
        {
            try
            {
                if (string.Equals(e.Request.Uri, EditorVirtualUrl, StringComparison.OrdinalIgnoreCase))
                {
                    MemoryStream ms = new MemoryStream(Encoding.UTF8.GetBytes(_html ?? string.Empty), false);
                    e.Response = _webView.CoreWebView2.Environment.CreateWebResourceResponse(
                        ms, 200, "OK", "Content-Type: text/html; charset=utf-8\r\nCache-Control: no-store");
                }
                else
                {
                    MemoryStream ms = new MemoryStream(Encoding.UTF8.GetBytes("Forbidden"), false);
                    e.Response = _webView.CoreWebView2.Environment.CreateWebResourceResponse(
                        ms, 403, "Forbidden", "Content-Type: text/plain; charset=utf-8\r\nCache-Control: no-store");
                }
            }
            catch
            {
            }
        }

        private void CoreWebView2_NavigationStarting(object sender, CoreWebView2NavigationStartingEventArgs e)
        {
            if (!IsTrustedMessageSource(e.Uri))
            {
                e.Cancel = true;
                _navigationBlocked = true;
            }
        }

        private void CoreWebView2_FrameNavigationStarting(object sender, CoreWebView2NavigationStartingEventArgs e)
        {
            e.Cancel = true;
            _navigationBlocked = true;
        }

        public static bool IsTrustedMessageSource(string source)
        {
            if (string.IsNullOrEmpty(source))
            {
                return false;
            }

            Uri uri;
            if (!Uri.TryCreate(source, UriKind.Absolute, out uri))
            {
                return false;
            }

            if (!string.Equals(uri.Scheme, "https", StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            if (!string.Equals(uri.Host, "lyz.local", StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            return string.Equals(uri.AbsolutePath, "/editor.html", StringComparison.OrdinalIgnoreCase);
        }

        private string BuildBridgeScript()
        {
            StringBuilder sb = new StringBuilder();
            sb.AppendLine("(function () {");
            sb.AppendLine("  if (window.__LYZ_BRIDGE_READY__) { return; }");
            sb.AppendLine("  window.__LYZ_BRIDGE_READY__ = true;");
            sb.AppendLine("  var pending = {};");
            sb.AppendLine("  var nextId = 1;");
            sb.AppendLine("  window.__LYZ_BRIDGE_RESOLVE__ = function (id, ok, data) {");
            sb.AppendLine("    var p = pending[id];");
            sb.AppendLine("    if (!p) { return; }");
            sb.AppendLine("    delete pending[id];");
            sb.AppendLine("    if (ok) { p.resolve(data); }");
            sb.AppendLine("    else { p.reject(new Error(data && data.error ? data.error : String(data || '네이티브 호출 실패'))); }");
            sb.AppendLine("  };");
            sb.AppendLine("  function call(method, args) {");
            sb.AppendLine("    return new Promise(function (resolve, reject) {");
            sb.AppendLine("      var id = nextId++;");
            sb.AppendLine("      pending[id] = { resolve: resolve, reject: reject };");
            sb.AppendLine("      try {");
            sb.AppendLine("        window.chrome.webview.postMessage({ id: id, method: method, args: args || [] });");
            sb.AppendLine("      } catch (e) {");
            sb.AppendLine("        delete pending[id];");
            sb.AppendLine("        reject(e);");
            sb.AppendLine("      }");
            sb.AppendLine("    });");
            sb.AppendLine("  }");
            sb.AppendLine("  window.__LYZ_EDITOR__ = {");
            sb.AppendLine("    getStatus: function () { return call('getStatus', []); },");
            sb.AppendLine("    listSlots: function () { return call('listSlots', []); },");
            sb.AppendLine("    loadSlot: function (slotName) { return call('loadSlot', [slotName]); },");
            sb.AppendLine("    pickAndLoad: function () { return call('pickAndLoad', []); },");
            sb.AppendLine("    saveBundle: function (slotName, files) { return call('saveBundle', [slotName, files]); },");
            sb.AppendLine("    listBackups: function (slotName) { return call('listBackups', [slotName]); },");
            sb.AppendLine("    createBackup: function (slotName) { return call('createBackup', [slotName]); },");
            sb.AppendLine("    restoreBackup: function (slotName, backupName) { return call('restoreBackup', [slotName, backupName]); }");
            sb.AppendLine("  };");
            sb.AppendLine("  window.dispatchEvent(new Event('lyz-native-ready'));");
            sb.AppendLine("})();");
            return sb.ToString();
        }

        private async void CoreWebView2_WebMessageReceived(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            if (!IsTrustedMessageSource(e.Source))
            {
                return;
            }
            _senderGuardVerified = true;

            RpcRequest request = null;
            try
            {
                request = _serializer.Deserialize<RpcRequest>(e.WebMessageAsJson);
            }
            catch
            {
                request = null;
            }

            if (request == null)
            {
                return;
            }

            long id = request.id;
            string method = request.method ?? string.Empty;
            object[] rawArgs = request.args;

            string errMsg = null;
            try
            {
                object result = ExecuteRpc(method, rawArgs);
                await SendBridgeResultAsync(id, true, result);
            }
            catch (Exception ex)
            {
                errMsg = ex.Message;
            }
            if (errMsg != null)
            {
                Dictionary<string, object> error = new Dictionary<string, object>();
                error["error"] = errMsg;
                await SendBridgeResultAsync(id, false, error);
            }
        }

        private async Task SendBridgeResultAsync(long id, bool ok, object result)
        {
            if (_webView == null || _webView.CoreWebView2 == null)
            {
                return;
            }

            string json = result == null ? "null" : _serializer.Serialize(result);
            string script = "window.__LYZ_BRIDGE_RESOLVE__(" + id.ToString(CultureInfo.InvariantCulture) + ", " + (ok ? "true" : "false") + ", " + json + ");";
            try
            {
                await _webView.CoreWebView2.ExecuteScriptAsync(script);
            }
            catch
            {
            }
        }

        private object ExecuteRpc(string method, object[] args)
        {
            if (string.Equals(method, "getStatus", StringComparison.OrdinalIgnoreCase))
                return GetStatus();
            if (string.Equals(method, "listSlots", StringComparison.OrdinalIgnoreCase))
                return ListSlots();
            if (string.Equals(method, "loadSlot", StringComparison.OrdinalIgnoreCase))
                return LoadSlot(GetStringArg(args, 0));
            if (string.Equals(method, "pickAndLoad", StringComparison.OrdinalIgnoreCase))
                return PickAndLoad();
            if (string.Equals(method, "saveBundle", StringComparison.OrdinalIgnoreCase))
                return SaveBundle(GetStringArg(args, 0), GetDictionaryArg(args, 1));
            if (string.Equals(method, "listBackups", StringComparison.OrdinalIgnoreCase))
                return ListBackups(GetStringArg(args, 0));
            if (string.Equals(method, "createBackup", StringComparison.OrdinalIgnoreCase))
                return CreateBackup(GetStringArg(args, 0));
            if (string.Equals(method, "restoreBackup", StringComparison.OrdinalIgnoreCase))
                return RestoreBackup(GetStringArg(args, 0), GetStringArg(args, 1));

            throw new InvalidOperationException("지원하지 않는 네이티브 호출입니다: " + method);
        }

        private static string GetStringArg(object[] args, int index)
        {
            if (args == null || index < 0 || index >= args.Length)
                return null;
            return args[index] as string;
        }

        private static Dictionary<string, object> GetDictionaryArg(object[] args, int index)
        {
            if (args == null || index < 0 || index >= args.Length)
                return new Dictionary<string, object>();
            Dictionary<string, object> dict = args[index] as Dictionary<string, object>;
            return dict ?? new Dictionary<string, object>();
        }

        private string ResolveSlotPath(string slotName)
        {
            if (string.IsNullOrWhiteSpace(slotName) ||
                slotName.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 ||
                slotName.IndexOf('\\') >= 0 ||
                slotName.IndexOf('/') >= 0 ||
                slotName == "." ||
                slotName == "..")
            {
                throw new SaveSafetyException("슬롯 이름이 올바르지 않습니다.");
            }
            string root = SaveStore.ValidateSafePath(_currentRootDir);
            string slotDir = SaveStore.ValidateSafePath(Path.Combine(root, slotName));
            if (!slotDir.StartsWith(root.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase))
            {
                throw new SaveSafetyException("슬롯 경로가 허용 범위를 벗어났습니다.");
            }
            return slotDir;
        }

        private object GetStatus()
        {
            Dictionary<string, object> status = new Dictionary<string, object>();
            status["ok"] = true;
            status["connected"] = true;
            status["rootDir"] = _currentRootDir;
            status["gameRunning"] = SaveStore.IsGameRunning();
            status["selfTest"] = _selfTestMode;
            status["slots"] = ListSlots();
            return status;
        }

        private object ListSlots()
        {
            return SaveStore.ListSlots(_currentRootDir);
        }

        private object LoadSlot(string slotName)
        {
            string slotDir = ResolveSlotPath(slotName);
            if (!Directory.Exists(slotDir))
                throw new DirectoryNotFoundException("슬롯 디렉터리를 찾을 수 없습니다: " + slotDir);

            Dictionary<string, object> result = new Dictionary<string, object>();
            result["name"] = Path.GetFileName(slotDir);
            result["files"] = SaveStore.LoadSlot(slotDir);
            result["backups"] = SaveStore.ListBackups(slotDir);
            return result;
        }

        private object PickAndLoad()
        {
            using (FolderBrowserDialog dialog = new FolderBrowserDialog())
            {
                dialog.Description = "용윤입지전 세이브 슬롯 폴더(SaveSlotN)를 선택하세요.";
                dialog.ShowNewFolderButton = false;

                if (!string.IsNullOrEmpty(_currentRootDir) && Directory.Exists(_currentRootDir))
                    dialog.SelectedPath = _currentRootDir;

                if (dialog.ShowDialog(this) != DialogResult.OK)
                    return new Dictionary<string, object> { { "cancelled", true } };

                string picked = SaveStore.ValidateSafePath(dialog.SelectedPath);
                if (!Directory.Exists(picked))
                    throw new DirectoryNotFoundException("선택한 폴더가 존재하지 않습니다.");

                for (int i = 0; i < SaveStore.KnownFiles.Length; i++)
                {
                    string filePath = Path.Combine(picked, SaveStore.KnownFiles[i]);
                    if (!File.Exists(filePath))
                        throw new FileNotFoundException("필수 세이브 파일이 없습니다: " + SaveStore.KnownFiles[i], filePath);
                }

                string parent = Path.GetDirectoryName(picked);
                if (!string.IsNullOrEmpty(parent))
                    _currentRootDir = parent;

                Dictionary<string, object> result = new Dictionary<string, object>();
                result["name"] = Path.GetFileName(picked);
                result["files"] = SaveStore.LoadSlot(picked);
                result["backups"] = SaveStore.ListBackups(picked);
                return result;
            }
        }

        private object SaveBundle(string slotName, Dictionary<string, object> rawFiles)
        {
            string slotDir = ResolveSlotPath(slotName);
            SaveOperationResult opResult = SaveStore.SaveSlot(slotDir, rawFiles, true);

            Dictionary<string, object> result = new Dictionary<string, object>();
            result["ok"] = opResult.ok;
            result["savedFiles"] = opResult.savedFiles;
            result["backupName"] = opResult.backupName;
            result["backups"] = opResult.backups;
            return result;
        }

        private object ListBackups(string slotName)
        {
            if (string.IsNullOrWhiteSpace(slotName))
                return new List<BackupEntry>();

            try
            {
                string slotDir = ResolveSlotPath(slotName);
                if (!Directory.Exists(slotDir))
                    return new List<BackupEntry>();
                return SaveStore.ListBackups(slotDir);
            }
            catch
            {
                return new List<BackupEntry>();
            }
        }

        private object CreateBackup(string slotName)
        {
            string slotDir = ResolveSlotPath(slotName);
            if (!Directory.Exists(slotDir))
                throw new DirectoryNotFoundException("슬롯 디렉터리를 찾을 수 없습니다: " + slotDir);

            string backupPath = SaveStore.CreateBackup(slotDir);
            Dictionary<string, object> result = new Dictionary<string, object>();
            result["backupPath"] = backupPath;
            result["backups"] = SaveStore.ListBackups(slotDir);
            return result;
        }

        private object RestoreBackup(string slotName, string backupName)
        {
            string slotDir = ResolveSlotPath(slotName);
            if (!Directory.Exists(slotDir))
                throw new DirectoryNotFoundException("슬롯 디렉터리를 찾을 수 없습니다: " + slotDir);

            SaveOperationResult opResult = SaveStore.RestoreBackup(slotDir, backupName);
            Dictionary<string, object> result = new Dictionary<string, object>();
            result["ok"] = opResult.ok;
            result["files"] = SaveStore.LoadSlot(slotDir);
            result["savedFiles"] = opResult.savedFiles;
            result["backupName"] = opResult.backupName;
            result["backups"] = opResult.backups;
            return result;
        }

        private async void CoreWebView2_NavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            if (!_selfTestMode || _selfTestStarted)
            {
                return;
            }
            _selfTestStarted = true;

            try
            {
                await Task.Delay(350);

                string uiProbeJson = await _webView.CoreWebView2.ExecuteScriptAsync(
                    "(function(){try{var b=document.getElementById('conn-badge');return {ui:!!window.__LYZ_UI__,badge:b?b.textContent:'',tabs:document.querySelectorAll('[role=\"tab\"]').length,kungfus:(window.LyzCatalogData&&window.LyzCatalogData.kungfus)?window.LyzCatalogData.kungfus.length:-1,url:window.location.href};}catch(e){return {error:String(e)};}})()");

                string blockProbe = await RunNavigationBlockingProbeAsync();

                bool trustedOk = IsTrustedMessageSource(EditorVirtualUrl) &&
                                 !IsTrustedMessageSource("https://evil.local/editor.html") &&
                                 !IsTrustedMessageSource("about:blank") &&
                                 !IsTrustedMessageSource("data:text/html,<h1>x</h1>");

                PrepareSelfTestSeed();

                string script = BuildSelfTestScript();
                await _webView.CoreWebView2.ExecuteScriptAsync(script);

                object doneObject = null;
                DateTime deadline = DateTime.UtcNow.AddSeconds(30);
                while (DateTime.UtcNow < deadline)
                {
                    string doneJson = await _webView.CoreWebView2.ExecuteScriptAsync("window.__LYZ_ST_DONE__ || null");
                    if (!string.IsNullOrEmpty(doneJson) && !string.Equals(doneJson, "null", StringComparison.OrdinalIgnoreCase))
                    {
                        try
                        {
                            doneObject = _serializer.DeserializeObject(doneJson);
                        }
                        catch
                        {
                            doneObject = null;
                        }
                        if (doneObject != null)
                        {
                            break;
                        }
                    }
                    await Task.Delay(100);
                }

                bool jsOk = false;
                string jsError = null;
                Dictionary<string, object> doneDict = doneObject as Dictionary<string, object>;
                if (doneDict != null)
                {
                    object okValue;
                    if (doneDict.TryGetValue("ok", out okValue) && okValue is bool)
                        jsOk = (bool)okValue;
                    object errValue;
                    if (doneDict.TryGetValue("error", out errValue) && errValue != null)
                        jsError = Convert.ToString(errValue, CultureInfo.InvariantCulture);
                }

                string slotDir = Path.Combine(_selfTestOutDir, "seed", "SaveSlot0");
                Dictionary<string, SlotFilePayload> loaded = SaveStore.LoadSlot(slotDir);
                long afterMoney = FindHeroMoney(loaded, 0);
                long beforeMoney = await ReadBeforeMoneyFromDomFallbackAsync();

                int backupCount = SaveStore.ListBackups(slotDir).Count;
                bool moneyOk = afterMoney == beforeMoney + 1;
                bool backupOk = backupCount >= 1;
                bool sourceOk = string.Equals(_webView.CoreWebView2.Source, EditorVirtualUrl, StringComparison.OrdinalIgnoreCase);
                bool navigationOk = _navigationBlocked && sourceOk;

                CoreWebView2Settings s = _webView.CoreWebView2.Settings;
                Dictionary<string, object> receipt = new Dictionary<string, object>();
                receipt["ok"] = jsOk && moneyOk && backupOk && navigationOk && trustedOk && _senderGuardVerified;
                receipt["selfTest"] = true;
                receipt["seedTested"] = !string.IsNullOrEmpty(_selfTestSeedPath);
                receipt["webView2Version"] = _webView.CoreWebView2.Environment.BrowserVersionString;
                receipt["beforeMoney"] = beforeMoney;
                receipt["afterMoney"] = afterMoney;
                receipt["backupCount"] = backupCount;
                receipt["navigationBlocked"] = navigationOk;
                receipt["senderGuardVerified"] = trustedOk && _senderGuardVerified;
                receipt["uiProbe"] = uiProbeJson;
                receipt["blockProbe"] = blockProbe;
                receipt["jsOk"] = jsOk;
                receipt["jsError"] = jsError;
                receipt["source"] = _webView.CoreWebView2.Source;
                receipt["virtualUrl"] = EditorVirtualUrl;
                receipt["settingsVerified"] = new Dictionary<string, object>
                {
                    { "AreDevToolsEnabled", s.AreDevToolsEnabled },
                    { "AreDefaultContextMenusEnabled", s.AreDefaultContextMenusEnabled },
                    { "AreHostObjectsAllowed", s.AreHostObjectsAllowed },
                    { "IsStatusBarEnabled", s.IsStatusBarEnabled }
                };
                WriteReceipt(receipt);
            }
            catch (Exception ex)
            {
                WriteSelfTestFailureReceipt(ex.ToString());
            }
            finally
            {
                Application.Exit();
            }
        }

        private async Task<string> RunNavigationBlockingProbeAsync()
        {
            _webView.CoreWebView2.Navigate("data:text/html,<h1>x</h1>");
            await Task.Delay(100);
            _webView.CoreWebView2.Navigate("https://example.invalid/");
            await Task.Delay(100);
            if (_webView == null || _webView.CoreWebView2 == null)
                return string.Empty;
            return _webView.CoreWebView2.Source;
        }

        private async Task<long> ReadBeforeMoneyFromDomFallbackAsync()
        {
            try
            {
                string raw = await _webView.CoreWebView2.ExecuteScriptAsync(
                    "window.__LYZ_ST_BEFORE__ == null ? null : window.__LYZ_ST_BEFORE__");
                if (string.IsNullOrEmpty(raw) || raw == "null")
                    return -1L;
                string s = raw.Trim();
                if (s.Length >= 2 && s[0] == '"' && s[s.Length - 1] == '"')
                    s = s.Substring(1, s.Length - 2);
                long v;
                if (long.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out v))
                    return v;
                double d;
                if (double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out d))
                    return (long)d;
            }
            catch
            {
            }
            return -1L;
        }

        private string BuildSelfTestScript()
        {
            return "window.__LYZ_EDITOR__.loadSlot('SaveSlot0')" +
                   ".then(function(x){ " +
                   "window.__LYZ_UI__.loadRawFiles(x.files, x.name); " +
                   "window.__LYZ_UI__.selectTab('heroes'); " +
                   "var pbtn = document.getElementById('btn-select-player'); if (pbtn) pbtn.click(); " +
                   "window.__LYZ_UI__.selectTab('inventory'); " +
                   "var labels = document.querySelectorAll('#inventory-detail label'); " +
                   "var moneyInput = null; " +
                   "for (var i = 0; i < labels.length; i++) { " +
                   "  if (labels[i].textContent && labels[i].textContent.indexOf('은전') >= 0) { " +
                   "    moneyInput = labels[i].querySelector('input'); break; " +
                   "  } " +
                   "} " +
                   "if (!moneyInput) throw new Error('은전 입력 칸을 찾을 수 없습니다.'); " +
                   "window.__LYZ_ST_BEFORE__ = Number(moneyInput.value || 0); " +
                   "moneyInput.value = String(window.__LYZ_ST_BEFORE__ + 1); " +
                   "moneyInput.dispatchEvent(new Event('change')); " +
                   "return window.__LYZ_EDITOR__.saveBundle('SaveSlot0', window.__LYZ_UI__.serializeFiles()); " +
                   "})" +
                   ".then(function(r){ window.__LYZ_ST_DONE__ = { ok: true, backups: (r && r.backups ? r.backups.length : 0) }; })" +
                   ".catch(function(e){ window.__LYZ_ST_DONE__ = { ok: false, error: String(e) }; });";
        }

        private void PrepareSelfTestSeed()
        {
            string target = Path.Combine(_selfTestOutDir, "seed", "SaveSlot0");
            if (!Directory.Exists(target))
                Directory.CreateDirectory(target);

            if (!string.IsNullOrEmpty(_selfTestSeedPath) && Directory.Exists(_selfTestSeedPath))
            {
                CopyDirectory(_selfTestSeedPath, target);
                return;
            }

            UTF8Encoding utf8NoBom = new UTF8Encoding(false);
            File.WriteAllText(Path.Combine(target, "Info"),
                "{\"SaveVersion\":\"1.0.0\",\"SaveTime\":\"2026-11-20 00:00:00\",\"SaveDetail\":\"\"}", utf8NoBom);
            File.WriteAllText(Path.Combine(target, "Save"),
                "{\"chapter\":1,\"worldTime\":{\"year\":1,\"month\":1,\"day\":1},\"speEnhanceStone\":10}", utf8NoBom);

            string heroJson =
                "[{\"heroID\":0,\"heroName\":\"용윤테스트\",\"heroFamilyName\":\"용\"," +
                "\"hp\":100,\"maxhp\":100," +
                "\"itemListData\":{\"money\":100,\"maxWeight\":100,\"allItem\":[]}," +
                "\"baseAttri\":[10,10,10,10,10,10]," +
                "\"maxAttri\":[10,10,10,10,10,10]," +
                "\"baseFightSkill\":[10,10,10,10,10,10,10,10,10]," +
                "\"maxFightSkill\":[10,10,10,10,10,10,10,10,10]," +
                "\"baseLivingSkill\":[10,10,10,10,10,10,10,10,10]," +
                "\"maxLivingSkill\":[10,10,10,10,10,10,10,10,10]," +
                "\"kungfuSkills\":[]," +
                "\"attackSkillSaveRecord\":[-1,-1,-1,-1,-1,-1,-1,-1]," +
                "\"heroTagData\":[]," +
                "\"equipSkills\":{}}]";
            File.WriteAllText(Path.Combine(target, "Hero"), heroJson, utf8NoBom);
            File.WriteAllText(Path.Combine(target, "TempHero"), "[]", utf8NoBom);
        }

        private static void CopyDirectory(string source, string target)
        {
            if (!Directory.Exists(target))
                Directory.CreateDirectory(target);

            string[] files = Directory.GetFiles(source);
            for (int i = 0; i < files.Length; i++)
                File.Copy(files[i], Path.Combine(target, Path.GetFileName(files[i])), true);

            string[] dirs = Directory.GetDirectories(source);
            for (int i = 0; i < dirs.Length; i++)
                CopyDirectory(dirs[i], Path.Combine(target, Path.GetFileName(dirs[i])));
        }

        private long FindHeroMoney(Dictionary<string, SlotFilePayload> files, int heroId)
        {
            SlotFilePayload payload;
            if (files == null || !files.TryGetValue("Hero", out payload) || payload == null || string.IsNullOrEmpty(payload.text))
                return -1L;

            try
            {
                object[] arr = _serializer.DeserializeObject(payload.text) as object[];
                if (arr == null)
                    return -1L;

                for (int i = 0; i < arr.Length; i++)
                {
                    Dictionary<string, object> d = arr[i] as Dictionary<string, object>;
                    if (d == null)
                        continue;

                    object idObj;
                    if (!d.TryGetValue("heroID", out idObj) || idObj == null)
                        continue;
                    if (Convert.ToInt32(idObj, CultureInfo.InvariantCulture) != heroId)
                        continue;

                    object mObj;
                    if (!d.TryGetValue("itemListData", out mObj) || mObj == null)
                        return -1L;

                    Dictionary<string, object> m = mObj as Dictionary<string, object>;
                    if (m == null)
                        return -1L;

                    object moneyObj;
                    if (!m.TryGetValue("money", out moneyObj) || moneyObj == null)
                        return -1L;
                    return Convert.ToInt64(moneyObj, CultureInfo.InvariantCulture);
                }
            }
            catch
            {
            }
            return -1L;
        }

        private void WriteReceipt(Dictionary<string, object> receipt)
        {
            try
            {
                if (!Directory.Exists(_selfTestOutDir))
                    Directory.CreateDirectory(_selfTestOutDir);
                string json = _serializer.Serialize(receipt);
                File.WriteAllText(Path.Combine(_selfTestOutDir, "receipt.json"), json, new UTF8Encoding(false));
            }
            catch
            {
            }
        }

        private void WriteSelfTestFailureReceipt(string message)
        {
            Dictionary<string, object> receipt = new Dictionary<string, object>();
            receipt["ok"] = false;
            receipt["error"] = message ?? "unknown";
            receipt["utc"] = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture);
            WriteReceipt(receipt);
        }

        private sealed class RpcRequest
        {
            public long id;
            public string method;
            public object[] args;
        }
    }
}
