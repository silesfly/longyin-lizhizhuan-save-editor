using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

namespace LongYinSaveEditor
{
    public sealed class SaveSafetyException : Exception
    {
        public SaveSafetyException(string message) : base(message) { }
        public SaveSafetyException(string message, Exception innerException) : base(message, innerException) { }
    }

    public sealed class SlotFilePayload
    {
        public string text;
        public bool isGzip;
        public bool hasBom;
    }

    public sealed class SlotEntry
    {
        public string name;
        public string path;
        public string version;
        public string saveTime;
    }

    public sealed class BackupEntry
    {
        public string name;
        public long mtime;
    }

    public sealed class SaveOperationResult
    {
        public bool ok;
        public List<string> savedFiles;
        public string backupName;
        public List<BackupEntry> backups;
    }

    public static class SaveStore
    {
        public static readonly string[] KnownFiles = { "Info", "Save", "Hero", "TempHero" };
        public const int MaxBackups = 20;
        public const string BackupDirName = ".lyz_backups";

        private const uint GenericRead = 0x80000000;
        private const uint OpenExisting = 3;
        private const uint FileFlagBackupSemantics = 0x02000000;
        private const uint FileFlagOpenReparsePoint = 0x00200000;
        private const int ErrorFileNotFound = 2;
        private const int ErrorPathNotFound = 3;
        private const int InvalidHandleValue = -1;

        [StructLayout(LayoutKind.Sequential)]
        private struct ByHandleFileInformation
        {
            public uint FileAttributes;
            public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
            public uint VolumeSerialNumber;
            public uint FileSizeHigh;
            public uint FileSizeLow;
            public uint NumberOfLinks;
            public uint FileIndexHigh;
            public uint FileIndexLow;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateFile(
            string fileName, uint desiredAccess, uint shareMode, IntPtr securityAttributes,
            uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetFileInformationByHandle(
            IntPtr fileHandle, out ByHandleFileInformation fileInformation);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern uint GetFinalPathNameByHandle(
            IntPtr fileHandle, StringBuilder filePath, uint filePathLength, uint flags);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        public static JavaScriptSerializer CreateSerializer()
        {
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            serializer.MaxJsonLength = int.MaxValue;
            serializer.RecursionLimit = 128;
            return serializer;
        }

        public static string GetDefaultSaveDirectory()
        {
            string profile = Environment.GetEnvironmentVariable("USERPROFILE");
            if (String.IsNullOrEmpty(profile))
                profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            return Path.Combine(profile, "AppData\\LocalLow\\TppStudio\\LongYinLiZhiZhuan\\Save");
        }

        public static string GetDefaultBackupSaveDirectory()
        {
            return GetDefaultSaveDirectory() + "_backup";
        }

        public static bool IsGameRunning()
        {
            if (Environment.GetEnvironmentVariable("LYZ_SIMULATE_GAME_RUNNING") == "1")
                return true;

            Process[] processes;
            try
            {
                processes = Process.GetProcesses();
            }
            catch
            {
                return false;
            }

            for (int i = 0; i < processes.Length; i++)
            {
                try
                {
                    if (processes[i].ProcessName.IndexOf("longyinlizhizhuan",
                        StringComparison.OrdinalIgnoreCase) >= 0)
                        return true;
                }
                catch
                {
                }
                finally
                {
                    processes[i].Dispose();
                }
            }
            return false;
        }

        public static void EnsureGameNotRunning()
        {
            if (IsGameRunning())
                throw new SaveSafetyException("게임이 실행 중이므로 저장 파일을 변경할 수 없습니다.");
        }

        public static string ValidateSafePath(string rawPath)
        {
            if (String.IsNullOrWhiteSpace(rawPath))
                throw new SaveSafetyException("경로가 비어 있습니다.");

            if (rawPath.StartsWith("\\\\", StringComparison.Ordinal) ||
                rawPath.StartsWith("//", StringComparison.Ordinal))
                throw new SaveSafetyException("네트워크 경로는 사용할 수 없습니다.");

            string path = Path.GetFullPath(rawPath);
            string root = Path.GetPathRoot(path);
            if (String.IsNullOrEmpty(root))
                throw new SaveSafetyException("올바른 경로가 아닙니다.");

            string remainder = path.Substring(root.Length);
            string[] parts = remainder.Split(new char[] { '\\', '/' },
                StringSplitOptions.RemoveEmptyEntries);

            for (int i = 0; i < parts.Length; i++)
            {
                string part = parts[i];
                if (part.IndexOf(':') >= 0)
                    throw new SaveSafetyException("경로에 대체 데이터 스트림 문자가 포함되어 있습니다.");

                string stem = part;
                int dot = stem.IndexOf('.');
                if (dot >= 0)
                    stem = stem.Substring(0, dot);
                stem = stem.TrimEnd(' ', '.');

                if (IsReservedDeviceName(stem))
                    throw new SaveSafetyException("Windows 예약 장치 이름은 사용할 수 없습니다.");
            }

            string current = root;
            CheckExistingPathComponent(current);

            for (int i = 0; i < parts.Length; i++)
            {
                current = Path.Combine(current, parts[i]);
                CheckExistingPathComponent(current);
            }

            return path;
        }

        private static bool IsReservedDeviceName(string value)
        {
            string name = value.ToLowerInvariant();
            if (name == "con" || name == "prn" || name == "aux" || name == "nul")
                return true;

            if (name.Length == 4 &&
                (name.StartsWith("com", StringComparison.Ordinal) ||
                 name.StartsWith("lpt", StringComparison.Ordinal)) &&
                name[3] >= '1' && name[3] <= '9')
                return true;

            return false;
        }

        private static void CheckExistingPathComponent(string path)
        {
            if (!File.Exists(path) && !Directory.Exists(path))
                return;

            FileAttributes attributes;
            try
            {
                attributes = File.GetAttributes(path);
            }
            catch (Exception ex)
            {
                throw new SaveSafetyException("경로 정보를 확인할 수 없습니다.", ex);
            }

            if ((attributes & FileAttributes.ReparsePoint) != 0)
                throw new SaveSafetyException("재분석 지점을 포함한 경로는 사용할 수 없습니다.");

            bool isDirectory = (attributes & FileAttributes.Directory) != 0;
            IntPtr handle = CreateFile(path, GenericRead, 7, IntPtr.Zero, OpenExisting,
                FileFlagOpenReparsePoint | (isDirectory ? FileFlagBackupSemantics : 0), IntPtr.Zero);

            if (handle == new IntPtr(InvalidHandleValue))
            {
                int error = Marshal.GetLastWin32Error();
                if (error == ErrorFileNotFound || error == ErrorPathNotFound)
                    return;
                throw new SaveSafetyException("경로의 실제 위치를 확인할 수 없습니다.");
            }

            try
            {
                ByHandleFileInformation information;
                if (!GetFileInformationByHandle(handle, out information))
                    throw new SaveSafetyException("경로의 실제 위치를 확인할 수 없습니다.");

                if (!isDirectory && information.NumberOfLinks > 1)
                    throw new SaveSafetyException("하드 링크가 여러 개인 파일은 사용할 수 없습니다.");

                StringBuilder finalPath = new StringBuilder(512);
                uint length = GetFinalPathNameByHandle(handle, finalPath,
                    (uint)finalPath.Capacity, 0);
                if (length == 0)
                    throw new SaveSafetyException("경로의 실제 위치를 확인할 수 없습니다.");

                if (length >= finalPath.Capacity)
                {
                    finalPath = new StringBuilder((int)length + 1);
                    length = GetFinalPathNameByHandle(handle, finalPath,
                        (uint)finalPath.Capacity, 0);
                    if (length == 0 || length >= finalPath.Capacity)
                        throw new SaveSafetyException("경로의 실제 위치를 확인할 수 없습니다.");
                }

                string resolved = finalPath.ToString();
                if (resolved.StartsWith("\\\\?\\UNC\\", StringComparison.OrdinalIgnoreCase))
                    throw new SaveSafetyException("네트워크 경로는 사용할 수 없습니다.");

                string normalizedResolved = NormalizeFinalPath(resolved);
                string normalizedRequested = NormalizeFinalPath(path);
                if (!String.Equals(normalizedResolved, normalizedRequested,
                    StringComparison.OrdinalIgnoreCase))
                    throw new SaveSafetyException("경로가 요청한 위치와 일치하지 않습니다.");
            }
            finally
            {
                CloseHandle(handle);
            }
        }

        private static string NormalizeFinalPath(string path)
        {
            string value = path;
            if (value.StartsWith("\\\\?\\", StringComparison.Ordinal))
                value = value.Substring(4);
            return Path.GetFullPath(value).TrimEnd('\\');
        }

        public static List<SlotEntry> ListSlots(string rootDir)
        {
            List<SlotEntry> slots = new List<SlotEntry>();
            List<string> roots = new List<string>();

            if (!String.IsNullOrWhiteSpace(rootDir))
            {
                roots.Add(rootDir);
            }
            else
            {
                roots.Add(GetDefaultSaveDirectory());
                roots.Add(GetDefaultBackupSaveDirectory());
            }

            for (int r = 0; r < roots.Count; r++)
            {
                string root = roots[r];
                if (String.IsNullOrWhiteSpace(root) || !Directory.Exists(root))
                    continue;

                root = ValidateSafePath(root);
                string[] directories = Directory.GetDirectories(root);
                for (int i = 0; i < directories.Length; i++)
                {
                    string slotPath = ValidateSafePath(directories[i]);
                    string slotName = Path.GetFileName(slotPath);
                    if (String.IsNullOrEmpty(slotName) || slotName.StartsWith(".", StringComparison.Ordinal))
                        continue;

                    string infoPath = Path.Combine(slotPath, "Info");
                    string savePath = Path.Combine(slotPath, "Save");
                    if (!File.Exists(infoPath) || !File.Exists(savePath))
                        continue;

                    string version = "";
                    string saveTime = "";

                    try
                    {
                        Dictionary<string, object> info =
                            CreateSerializer().Deserialize<Dictionary<string, object>>(
                                ReadTextFile(infoPath));
                        version = FindStringValue(info, "SaveVersion");
                        if (String.IsNullOrEmpty(version))
                            version = FindStringValue(info, "version");
                        saveTime = FindStringValue(info, "SaveTime");
                    }
                    catch
                    {
                    }

                    if (String.IsNullOrEmpty(saveTime))
                    {
                        try
                        {
                            Dictionary<string, object> save =
                                CreateSerializer().Deserialize<Dictionary<string, object>>(
                                    ReadTextFile(savePath));
                            saveTime = FindStringValue(save, "saveTime");
                            if (String.IsNullOrEmpty(saveTime))
                                saveTime = FindStringValue(save, "time");
                        }
                        catch
                        {
                        }
                    }

                    SlotEntry entry = new SlotEntry();
                    entry.name = slotName;
                    entry.path = slotPath;
                    entry.version = version;
                    entry.saveTime = saveTime;
                    slots.Add(entry);
                }
            }

            slots.Sort(delegate(SlotEntry a, SlotEntry b)
            {
                return String.Compare(a.name, b.name, StringComparison.OrdinalIgnoreCase);
            });
            return slots;
        }

        private static string FindStringValue(Dictionary<string, object> values, string key)
        {
            if (values == null)
                return "";

            foreach (KeyValuePair<string, object> pair in values)
            {
                if (String.Equals(pair.Key, key, StringComparison.OrdinalIgnoreCase) &&
                    pair.Value != null)
                    return Convert.ToString(pair.Value, CultureInfo.InvariantCulture);
            }
            return "";
        }

        public static Dictionary<string, SlotFilePayload> LoadSlot(string slotDir)
        {
            string safeSlot = ValidateSafePath(slotDir);
            Dictionary<string, SlotFilePayload> files =
                new Dictionary<string, SlotFilePayload>(StringComparer.OrdinalIgnoreCase);

            for (int i = 0; i < KnownFiles.Length; i++)
            {
                string filePath = ValidateSafePath(Path.Combine(safeSlot, KnownFiles[i]));
                if (!File.Exists(filePath))
                    throw new SaveSafetyException("저장 슬롯에 필요한 파일이 없습니다.");

                byte[] bytes = File.ReadAllBytes(filePath);
                files[KnownFiles[i]] = DecodePayload(bytes);
            }

            return files;
        }

        private static SlotFilePayload DecodePayload(byte[] bytes)
        {
            bool gzip = bytes.Length >= 2 && bytes[0] == 0x1f && bytes[1] == 0x8b;
            byte[] content = bytes;

            if (gzip)
            {
                using (MemoryStream input = new MemoryStream(bytes))
                using (GZipStream stream = new GZipStream(input, CompressionMode.Decompress))
                using (MemoryStream output = new MemoryStream())
                {
                    stream.CopyTo(output);
                    content = output.ToArray();
                }
            }

            bool bom = content.Length >= 3 &&
                content[0] == 0xef && content[1] == 0xbb && content[2] == 0xbf;
            int offset = bom ? 3 : 0;

            SlotFilePayload payload = new SlotFilePayload();
            payload.text = new UTF8Encoding(false, true).GetString(
                content, offset, content.Length - offset);
            payload.isGzip = gzip;
            payload.hasBom = bom;
            return payload;
        }

        public static Dictionary<string, SlotFilePayload> ConvertRawFileMap(
            Dictionary<string, object> rawFiles)
        {
            Dictionary<string, SlotFilePayload> result =
                new Dictionary<string, SlotFilePayload>(StringComparer.OrdinalIgnoreCase);
            if (rawFiles == null)
                return result;

            foreach (KeyValuePair<string, object> kv in rawFiles)
            {
                if (kv.Key == null || kv.Value == null)
                    continue;

                string asString = kv.Value as string;
                if (asString != null)
                {
                    SlotFilePayload textPayload = new SlotFilePayload();
                    textPayload.text = asString;
                    textPayload.isGzip = false;
                    textPayload.hasBom = false;
                    result[kv.Key] = textPayload;
                    continue;
                }

                Dictionary<string, object> dict = kv.Value as Dictionary<string, object>;
                if (dict == null)
                    continue;

                SlotFilePayload payload = new SlotFilePayload();
                object t, g, b;
                if (dict.TryGetValue("text", out t) && t != null)
                    payload.text = t as string ?? Convert.ToString(t, CultureInfo.InvariantCulture);
                else
                    payload.text = String.Empty;

                if (dict.TryGetValue("isGzip", out g) && g != null)
                    payload.isGzip = Convert.ToBoolean(g, CultureInfo.InvariantCulture);

                if (dict.TryGetValue("hasBom", out b) && b != null)
                    payload.hasBom = Convert.ToBoolean(b, CultureInfo.InvariantCulture);

                result[kv.Key] = payload;
            }

            return result;
        }

        public static string CreateBackup(string slotDir)
        {
            string safeSlot = ValidateSafePath(slotDir);
            if (!Directory.Exists(safeSlot))
                throw new SaveSafetyException("저장 슬롯 경로가 없습니다.");

            string parent = Directory.GetParent(safeSlot).FullName;
            string backupRoot = ValidateSafePath(Path.Combine(parent, BackupDirName));
            Directory.CreateDirectory(backupRoot);
            ValidateSafePath(backupRoot);

            string backupName = Path.GetFileName(safeSlot) + "_" +
                DateTime.Now.ToString("yyyyMMdd-HHmmss", CultureInfo.InvariantCulture) + "_" +
                Guid.NewGuid().ToString("N").Substring(0, 8);
            string backupPath = ValidateSafePath(Path.Combine(backupRoot, backupName));
            Directory.CreateDirectory(backupPath);
            ValidateSafePath(backupPath);

            try
            {
                for (int i = 0; i < KnownFiles.Length; i++)
                {
                    string source = ValidateSafePath(Path.Combine(safeSlot, KnownFiles[i]));
                    if (!File.Exists(source))
                        throw new SaveSafetyException("백업할 저장 파일이 없습니다.");

                    string destination = ValidateSafePath(Path.Combine(backupPath, KnownFiles[i]));
                    File.Copy(source, destination, false);
                    VerifySameFile(source, destination);
                }
            }
            catch
            {
                try
                {
                    if (Directory.Exists(backupPath))
                        Directory.Delete(backupPath, true);
                }
                catch
                {
                }
                throw;
            }

            PruneBackups(safeSlot);
            return backupPath;
        }

        public static SaveOperationResult SaveSlot(
            string slotDir, Dictionary<string, object> rawFiles, bool createBackup)
        {
            return SaveSlot(slotDir, ConvertRawFileMap(rawFiles), createBackup);
        }

        public static SaveOperationResult SaveSlot(
            string slotDir, Dictionary<string, SlotFilePayload> files, bool createBackup)
        {
            EnsureGameNotRunning();

            string safeSlot = ValidateSafePath(slotDir);
            if (!Directory.Exists(safeSlot))
                throw new SaveSafetyException("저장 슬롯 경로가 없습니다.");
            if (files == null)
                throw new SaveSafetyException("저장할 파일이 없습니다.");

            Dictionary<string, byte[]> newBytes =
                new Dictionary<string, byte[]>(StringComparer.OrdinalIgnoreCase);

            for (int i = 0; i < KnownFiles.Length; i++)
            {
                string name = KnownFiles[i];
                SlotFilePayload payload;
                if (!files.TryGetValue(name, out payload) || payload == null || payload.text == null)
                    throw new SaveSafetyException("저장 파일 내용이 올바르지 않습니다.");

                try
                {
                    CreateSerializer().DeserializeObject(payload.text);
                }
                catch (Exception ex)
                {
                    throw new SaveSafetyException("저장 파일의 JSON 형식이 올바르지 않습니다.", ex);
                }

                newBytes[name] = EncodePayload(payload);
            }

            List<string> targetPaths = new List<string>();
            for (int i = 0; i < KnownFiles.Length; i++)
                targetPaths.Add(ValidateSafePath(Path.Combine(safeSlot, KnownFiles[i])));

            string backupPath = null;
            string backupName = null;
            if (createBackup)
            {
                backupPath = CreateBackup(safeSlot);
                backupName = Path.GetFileName(backupPath);
            }

            List<string> pendingPaths = new List<string>();

            try
            {
                for (int i = 0; i < KnownFiles.Length; i++)
                {
                    string pending = ValidateSafePath(Path.Combine(
                        safeSlot, ".pending-" + Guid.NewGuid().ToString("N")));
                    pendingPaths.Add(pending);
                    File.WriteAllBytes(pending, newBytes[KnownFiles[i]]);
                    ValidateSafePath(pending);
                }

                for (int i = 0; i < KnownFiles.Length; i++)
                {
                    string target = targetPaths[i];
                    string pending = pendingPaths[i];

                    if (File.Exists(target))
                    {
                        string replacement = ValidateSafePath(Path.Combine(
                            safeSlot, ".replace-" + Guid.NewGuid().ToString("N")));
                        File.Replace(pending, target, replacement, true);
                        if (File.Exists(replacement))
                            File.Delete(replacement);
                    }
                    else
                    {
                        File.Move(pending, target);
                    }
                }

                SaveOperationResult result = new SaveOperationResult();
                result.ok = true;
                result.savedFiles = new List<string>(KnownFiles);
                result.backupName = backupName;
                result.backups = ListBackups(safeSlot);
                return result;
            }
            catch (Exception ex)
            {
                if (backupPath != null && Directory.Exists(backupPath))
                {
                    for (int i = 0; i < KnownFiles.Length; i++)
                    {
                        string backupFile = Path.Combine(backupPath, KnownFiles[i]);
                        if (!File.Exists(backupFile))
                            continue;

                        string target = targetPaths[i];
                        string rollback = Path.Combine(safeSlot,
                            ".rollback-" + Guid.NewGuid().ToString("N"));
                        try
                        {
                            File.Copy(backupFile, rollback, false);
                            if (File.Exists(target))
                                File.Replace(rollback, target, null, true);
                            else
                                File.Move(rollback, target);
                        }
                        catch
                        {
                            if (File.Exists(rollback))
                                File.Delete(rollback);
                        }
                    }
                }

                throw new SaveSafetyException("저장 중 오류가 발생하여 되돌리기를 시도했습니다.", ex);
            }
            finally
            {
                for (int i = 0; i < pendingPaths.Count; i++)
                {
                    try
                    {
                        if (File.Exists(pendingPaths[i]))
                            File.Delete(pendingPaths[i]);
                    }
                    catch
                    {
                    }
                }
            }
        }

        private static byte[] EncodePayload(SlotFilePayload payload)
        {
            byte[] textBytes = new UTF8Encoding(false).GetBytes(payload.text);
            byte[] content;

            if (payload.hasBom)
            {
                content = new byte[textBytes.Length + 3];
                content[0] = 0xef;
                content[1] = 0xbb;
                content[2] = 0xbf;
                Buffer.BlockCopy(textBytes, 0, content, 3, textBytes.Length);
            }
            else
            {
                content = textBytes;
            }

            if (!payload.isGzip)
                return content;

            using (MemoryStream output = new MemoryStream())
            {
                using (GZipStream gzip = new GZipStream(output, CompressionMode.Compress, true))
                    gzip.Write(content, 0, content.Length);
                return output.ToArray();
            }
        }

        private static void VerifySameFile(string first, string second)
        {
            byte[] firstHash;
            byte[] secondHash;
            using (SHA256 sha = SHA256.Create())
            using (FileStream stream = File.OpenRead(first))
                firstHash = sha.ComputeHash(stream);

            using (SHA256 sha = SHA256.Create())
            using (FileStream stream = File.OpenRead(second))
                secondHash = sha.ComputeHash(stream);

            if (!BytesEqual(firstHash, secondHash))
                throw new SaveSafetyException("백업 파일 검증에 실패했습니다.");
        }

        private static bool BytesEqual(byte[] left, byte[] right)
        {
            if (left == null || right == null || left.Length != right.Length)
                return false;

            int difference = 0;
            for (int i = 0; i < left.Length; i++)
                difference |= left[i] ^ right[i];
            return difference == 0;
        }

        private static string ReadTextFile(string path)
        {
            return DecodePayload(File.ReadAllBytes(path)).text;
        }

        public static List<BackupEntry> ListBackups(string slotDir)
        {
            string safeSlot = ValidateSafePath(slotDir);
            string parent = Directory.GetParent(safeSlot).FullName;
            string backupRoot = Path.Combine(parent, BackupDirName);
            List<BackupEntry> backups = new List<BackupEntry>();

            if (!Directory.Exists(backupRoot))
                return backups;

            backupRoot = ValidateSafePath(backupRoot);
            string prefix = Path.GetFileName(safeSlot) + "_";
            string[] directories = Directory.GetDirectories(backupRoot);

            for (int i = 0; i < directories.Length; i++)
            {
                string path = ValidateSafePath(directories[i]);
                string name = Path.GetFileName(path);
                if (!name.StartsWith(prefix, StringComparison.Ordinal))
                    continue;

                BackupEntry entry = new BackupEntry();
                entry.name = name;
                entry.mtime = Directory.GetLastWriteTimeUtc(path).Ticks;
                backups.Add(entry);
            }

            backups.Sort(delegate(BackupEntry a, BackupEntry b)
            {
                int compare = b.mtime.CompareTo(a.mtime);
                return compare != 0 ? compare : String.CompareOrdinal(b.name, a.name);
            });
            return backups;
        }

        public static SaveOperationResult RestoreBackup(string slotDir, string backupName)
        {
            EnsureGameNotRunning();

            string safeSlot = ValidateSafePath(slotDir);
            if (String.IsNullOrWhiteSpace(backupName) ||
                backupName.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 ||
                backupName.IndexOf('\\') >= 0 || backupName.IndexOf('/') >= 0 ||
                backupName == "." || backupName == "..")
                throw new SaveSafetyException("백업 이름이 올바르지 않습니다.");

            string parent = Directory.GetParent(safeSlot).FullName;
            string backupPath = ValidateSafePath(Path.Combine(
                parent, BackupDirName, backupName));

            string expectedPrefix = Path.GetFileName(safeSlot) + "_";
            if (!Path.GetFileName(backupPath).StartsWith(expectedPrefix, StringComparison.Ordinal) ||
                !Directory.Exists(backupPath))
                throw new SaveSafetyException("백업을 찾을 수 없습니다.");

            Dictionary<string, SlotFilePayload> payloads =
                new Dictionary<string, SlotFilePayload>(StringComparer.OrdinalIgnoreCase);

            for (int i = 0; i < KnownFiles.Length; i++)
            {
                string filePath = ValidateSafePath(Path.Combine(backupPath, KnownFiles[i]));
                if (!File.Exists(filePath))
                    throw new SaveSafetyException("백업 파일이 없습니다.");

                payloads[KnownFiles[i]] = DecodePayload(File.ReadAllBytes(filePath));
            }

            SaveOperationResult result = SaveSlot(safeSlot, payloads, true);
            result.backups = ListBackups(safeSlot);
            return result;
        }

        private static void PruneBackups(string slotDir)
        {
            List<BackupEntry> backups = ListBackups(slotDir);
            for (int i = MaxBackups; i < backups.Count; i++)
            {
                string path = Path.Combine(
                    Directory.GetParent(ValidateSafePath(slotDir)).FullName,
                    BackupDirName, backups[i].name);
                path = ValidateSafePath(path);

                string[] files = Directory.GetFiles(path);
                for (int f = 0; f < files.Length; f++)
                    File.Delete(ValidateSafePath(files[f]));
                Directory.Delete(path, false);
            }
        }
    }
}
