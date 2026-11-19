// Standalone .NET Framework 4.8 test executable.
// Compile with a reference to LongYinSaveEditor.exe.

using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;

internal static class SaveStoreTests
{
    private static int _assertions;

    private static void AssertTrue(bool condition, string message)
    {
        _assertions++;
        if (!condition)
            throw new Exception("ASSERT FAILED: " + message);
    }

    private static void AssertThrows(Action action, string message)
    {
        _assertions++;
        try
        {
            action();
        }
        catch
        {
            return;
        }

        throw new Exception("ASSERT FAILED: expected rejection: " + message);
    }

    private static Type FindSaveStoreType()
    {
        string exePath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "LongYinSaveEditor-v1.0.0.exe");
        if (File.Exists(exePath))
        {
            Type fromExe = Assembly.LoadFrom(exePath).GetType("LongYinSaveEditor.SaveStore", false);
            if (fromExe != null)
                return fromExe;
        }
        Type type = Type.GetType("LongYinSaveEditor.SaveStore, LongYinSaveEditor", false);
        if (type != null)
            return type;

        foreach (Assembly assembly in AppDomain.CurrentDomain.GetAssemblies())
        {
            type = assembly.GetType("LongYinSaveEditor.SaveStore", false);
            if (type != null)
                return type;
        }

        throw new InvalidOperationException(
            "Could not find LongYinSaveEditor.SaveStore. Add its assembly reference.");
    }

    private static object InvokeStatic(Type type, string methodName, params object[] args)
    {
        MethodInfo[] methods = type.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
        foreach (MethodInfo method in methods)
        {
            if (method.Name != methodName)
                continue;

            ParameterInfo[] parameters = method.GetParameters();
            if (parameters.Length != args.Length)
                continue;

            bool compatible = true;
            for (int i = 0; i < parameters.Length; i++)
            {
                if (args[i] != null && !parameters[i].ParameterType.IsInstanceOfType(args[i]))
                {
                    compatible = false;
                    break;
                }
            }
            if (!compatible)
                continue;

            try
            {
                return method.Invoke(null, args);
            }
            catch (TargetInvocationException exception)
            {
                if (exception.InnerException != null)
                    throw exception.InnerException;
                throw;
            }
        }

        throw new MissingMethodException(type.FullName, methodName);
    }

    private static string Sha256(byte[] bytes)
    {
        using (SHA256 sha = SHA256.Create())
        {
            byte[] hash = sha.ComputeHash(bytes);
            StringBuilder builder = new StringBuilder(hash.Length * 2);
            foreach (byte value in hash)
                builder.Append(value.ToString("x2"));
            return builder.ToString();
        }
    }

    private static byte[] Gzip(byte[] source)
    {
        using (MemoryStream output = new MemoryStream())
        {
            using (GZipStream gzip = new GZipStream(output, CompressionMode.Compress, true))
                gzip.Write(source, 0, source.Length);
            return output.ToArray();
        }
    }

    private static byte[] Gunzip(byte[] source)
    {
        using (MemoryStream input = new MemoryStream(source))
        using (GZipStream gzip = new GZipStream(input, CompressionMode.Decompress))
        using (MemoryStream output = new MemoryStream())
        {
            gzip.CopyTo(output);
            return output.ToArray();
        }
    }

    private static void WriteSlotFiles(string slotDir, string marker, bool gzip)
    {
        Directory.CreateDirectory(slotDir);
        string[] names = { "Info", "Save", "Hero", "TempHero" };
        string[] contents = {
            "{\"SaveVersion\":\"1.0.0\",\"SaveTime\":\"2026-11-20\",\"marker\":\"" + marker + "\"}",
            "{\"chapter\":1,\"marker\":\"" + marker + "\"}",
            "[{\"heroID\":0,\"heroName\":\"" + marker + "\"},null]",
            "[]"
        };

        UTF8Encoding utf8 = new UTF8Encoding(false);
        for (int i = 0; i < names.Length; i++)
        {
            byte[] raw = utf8.GetBytes(contents[i]);
            File.WriteAllBytes(Path.Combine(slotDir, names[i]), gzip ? Gzip(raw) : raw);
        }
    }

    private static void Run()
    {
        Type storeType = FindSaveStoreType();
        string root = Path.Combine(Path.GetTempPath(), "lyz-save-store-tests-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);

        try
        {
            string slot0 = Path.Combine(root, "SaveSlot0");
            WriteSlotFiles(slot0, "용윤GZip", true);

            object loadedGzip = InvokeStatic(storeType, "LoadSlot", slot0);
            AssertTrue(loadedGzip != null, "LoadSlot should read a GZip slot");

            InvokeStatic(storeType, "SaveSlot", slot0, loadedGzip, true);
            byte[] afterGzipHero = File.ReadAllBytes(Path.Combine(slot0, "Hero"));
            AssertTrue(afterGzipHero.Length >= 2 && afterGzipHero[0] == 0x1f && afterGzipHero[1] == 0x8b,
                "GZip Hero save should preserve gzip header");
            AssertTrue(Encoding.UTF8.GetString(Gunzip(afterGzipHero)).Contains("용윤GZip"),
                "GZip SaveSlot round-trip should preserve Hero JSON");

            string slot1 = Path.Combine(root, "SaveSlot1");
            WriteSlotFiles(slot1, "용윤평문", false);
            object loadedPlain = InvokeStatic(storeType, "LoadSlot", slot1);
            AssertTrue(loadedPlain != null, "LoadSlot should read a plain JSON slot");
            InvokeStatic(storeType, "SaveSlot", slot1, loadedPlain, false);
            AssertTrue(File.ReadAllText(Path.Combine(slot1, "Save"), Encoding.UTF8).Contains("\"chapter\":1"),
                "Plain SaveSlot round-trip should preserve Save JSON");

            IList listedSlots = InvokeStatic(storeType, "ListSlots", root) as IList;
            AssertTrue(listedSlots != null && listedSlots.Count == 2,
                "ListSlots should return 2 slots and skip .lyz_backups");

            string backupPath = Convert.ToString(InvokeStatic(storeType, "CreateBackup", slot0));
            AssertTrue(!String.IsNullOrEmpty(backupPath) && Directory.Exists(backupPath),
                "CreateBackup should create a backup directory");
            string backupHero = Path.Combine(backupPath, "Hero");
            AssertTrue(File.Exists(backupHero), "Backup directory should contain Hero file");
            string backupHash = Sha256(File.ReadAllBytes(backupHero));
            AssertTrue(backupHash.Length == 64, "Backup SHA-256 should be 64 hex chars");

            object maxBackupsValue = storeType.GetField("MaxBackups",
                BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static).GetValue(null);
            int maxBackups = Convert.ToInt32(maxBackupsValue);
            AssertTrue(maxBackups == 20, "MaxBackups should be 20");

            for (int index = 0; index < maxBackups + 2; index++)
            {
                WriteSlotFiles(slot0, "rev" + index, false);
                InvokeStatic(storeType, "CreateBackup", slot0);
            }
            string backupRoot = Path.Combine(root, ".lyz_backups");
            string[] backups = Directory.GetDirectories(backupRoot);
            AssertTrue(backups.Length <= maxBackups, "Backup pruning should enforce MaxBackups <= 20");

            WriteSlotFiles(slot0, "용윤GZip", true);
            string restoreTargetBackup = Convert.ToString(InvokeStatic(storeType, "CreateBackup", slot0));
            AssertTrue(!String.IsNullOrEmpty(restoreTargetBackup) && Directory.Exists(restoreTargetBackup),
                "CreateBackup should preserve current backup before restore test");

            WriteSlotFiles(slot0, "changed-marker", false);
            string backupName = Path.GetFileName(restoreTargetBackup);
            InvokeStatic(storeType, "RestoreBackup", slot0, backupName);
            byte[] restoredHero = File.ReadAllBytes(Path.Combine(slot0, "Hero"));
            string restoredText = (restoredHero.Length >= 2 && restoredHero[0] == 0x1f && restoredHero[1] == 0x8b)
                ? Encoding.UTF8.GetString(Gunzip(restoredHero))
                : Encoding.UTF8.GetString(restoredHero);
            AssertTrue(restoredText.Contains("용윤GZip"), "RestoreBackup should restore original Hero bytes");

            string[] invalidPaths = {
                @"\\server\share\SaveSlot0",
                Path.Combine(root, "SaveSlot0:stream"),
                Path.Combine(root, "nul.json"),
                Path.Combine(root, "COM1")
            };
            foreach (string invalid in invalidPaths)
            {
                AssertThrows(delegate
                {
                    InvokeStatic(storeType, "ValidateSafePath", invalid);
                }, invalid);
            }

            string target = Path.Combine(root, "junction-target");
            string junction = Path.Combine(root, "junction-link");
            Directory.CreateDirectory(target);
            try
            {
                ProcessJunction.Create(junction, target);
                AssertThrows(delegate
                {
                    InvokeStatic(storeType, "ValidateSafePath", junction);
                }, "NTFS junction/reparse point");
            }
            finally
            {
                ProcessJunction.Remove(junction);
            }

            string hardlinkTarget = Path.Combine(root, "hardlink-target.txt");
            string hardlink = Path.Combine(root, "hardlink.txt");
            File.WriteAllText(hardlinkTarget, "hardlink", Encoding.UTF8);
            if (HardLink.TryCreate(hardlink, hardlinkTarget))
            {
                AssertThrows(delegate
                {
                    InvokeStatic(storeType, "ValidateSafePath", hardlink);
                }, "hard link with more than one link");
            }

            string oldRunning = Environment.GetEnvironmentVariable("LYZ_SIMULATE_GAME_RUNNING");
            Environment.SetEnvironmentVariable("LYZ_SIMULATE_GAME_RUNNING", "1");
            try
            {
                AssertThrows(delegate
                {
                    InvokeStatic(storeType, "SaveSlot", slot1, loadedPlain, true);
                }, "game-running refusal");
            }
            finally
            {
                Environment.SetEnvironmentVariable("LYZ_SIMULATE_GAME_RUNNING", oldRunning);
            }

            byte[] beforeFailedSave = File.ReadAllBytes(Path.Combine(slot1, "Save"));
            AssertThrows(delegate
            {
                InvokeStatic(storeType, "SaveSlot", Path.Combine(root, "missing", "SaveSlotX"), loadedPlain, true);
            }, "failed save to missing directory should throw");
            AssertTrue(File.Exists(Path.Combine(slot1, "Save")), "Failed save should leave existing slot intact");
            AssertTrue(File.ReadAllBytes(Path.Combine(slot1, "Save")).Length == beforeFailedSave.Length,
                "Failed save should preserve original slot length");
        }
        finally
        {
            try
            {
                Directory.Delete(root, true);
            }
            catch
            {
            }
        }

        Console.WriteLine("SaveStore tests passed. Assertions: " + _assertions);
    }

    private static int Main()
    {
        try
        {
            Run();
            return 0;
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine(exception);
            return 1;
        }
    }

    private static class ProcessJunction
    {
        public static void Create(string link, string target)
        {
            if (Directory.Exists(link))
                return;

            System.Diagnostics.ProcessStartInfo start =
                new System.Diagnostics.ProcessStartInfo("cmd.exe");
            start.Arguments = "/c mklink /J \"" + link + "\" \"" + target + "\"";
            start.CreateNoWindow = true;
            start.UseShellExecute = false;
            start.RedirectStandardOutput = true;
            start.RedirectStandardError = true;

            using (System.Diagnostics.Process process = System.Diagnostics.Process.Start(start))
            {
                process.WaitForExit();
                if (process.ExitCode != 0)
                    throw new IOException("Could not create NTFS junction: " + process.StandardError.ReadToEnd());
            }
        }

        public static void Remove(string link)
        {
            if (Directory.Exists(link))
                Directory.Delete(link, false);
        }
    }

    private static class HardLink
    {
        [System.Runtime.InteropServices.DllImport("kernel32.dll",
            CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)]
        private static extern bool CreateHardLink(string newFileName, string existingFileName, IntPtr securityAttributes);

        public static bool TryCreate(string link, string target)
        {
            if (!Environment.OSVersion.Platform.ToString().StartsWith("Win", StringComparison.Ordinal))
                return false;
            return CreateHardLink(link, target, IntPtr.Zero);
        }
    }
}
