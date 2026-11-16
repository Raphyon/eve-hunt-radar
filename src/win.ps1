# Hunt Radar Windows helper — runs hidden, talks JSON lines over stdin/stdout.
# Commands:  WIN                -> {"titles":[...EVE character names...],"fg":"name or null"}
#            OCR x y w h path   -> {"lines":[...]}  (screenshot of that screen rect, read with Windows OCR)
#            KEYS               -> {"ok":true}      (Ctrl+A, Ctrl+C into the window in front — opt-in feature)
#            OCRL x y w h path  -> {"lines":[{"t":text,"y":center-y in the rect}]}  (one Local row lookup)
#            HOOK ON|OFF        -> watch for MIDDLE-clicks only (for the pilot lookup); WIN then also returns "clicks"
# Reads window titles only (like EVE-O Preview). Never reads or writes EVE's memory.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class MidClick {
  // Low-level mouse hook that only records MIDDLE-button presses (screen coords). Never blocks or alters input.
  delegate IntPtr Proc(int code, IntPtr w, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] struct PT { public int x; public int y; }
  [StructLayout(LayoutKind.Sequential)] struct HS { public PT pt; public uint data, flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr h; public uint m; public IntPtr w, l; public uint t; public PT p; }
  [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, Proc fn, IntPtr mod, uint tid);
  [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h, int c, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr h, uint a, uint b);
  [DllImport("user32.dll")] static extern bool PostThreadMessage(uint tid, uint m, IntPtr w, IntPtr l);
  [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string n);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  static Proc keep; static IntPtr hook = IntPtr.Zero; static uint tid; static System.Threading.Thread th;
  static readonly System.Collections.Concurrent.ConcurrentQueue<int[]> q = new System.Collections.Concurrent.ConcurrentQueue<int[]>();
  static IntPtr Cb(int code, IntPtr w, IntPtr l) {
    if (code >= 0 && (int)w == 0x0207) { var h = (HS)Marshal.PtrToStructure(l, typeof(HS)); q.Enqueue(new[] { h.pt.x, h.pt.y }); }
    return CallNextHookEx(hook, code, w, l);
  }
  public static void On() {
    if (th != null) return;
    th = new System.Threading.Thread(() => { tid = GetCurrentThreadId(); keep = Cb; hook = SetWindowsHookEx(14, keep, GetModuleHandle(null), 0); MSG m; while (GetMessage(out m, IntPtr.Zero, 0, 0) > 0) { } UnhookWindowsHookEx(hook); hook = IntPtr.Zero; });
    th.IsBackground = true; th.Start();
  }
  public static void Off() { if (th == null) return; PostThreadMessage(tid, 0x0012, IntPtr.Zero, IntPtr.Zero); th = null; int[] x; while (q.TryDequeue(out x)) { } }
  public static int[][] Drain() { var l = new List<int[]>(); int[] x; while (q.TryDequeue(out x)) l.Add(x); return l.ToArray(); }
}
public static class HR {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowTextLengthW(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
  static string Title(IntPtr h) { int n = GetWindowTextLengthW(h); if (n == 0) return ""; var sb = new StringBuilder(n + 1); GetWindowTextW(h, sb, n + 1); return sb.ToString(); }
  public static string[] EveTitles() {
    var list = new List<string>();
    EnumWindows((h, l) => { if (IsWindowVisible(h)) { var t = Title(h); if (t.StartsWith("EVE - ")) list.Add(t.Substring(6).Trim()); } return true; }, IntPtr.Zero);
    return list.ToArray();
  }
  public static string Foreground() { var t = Title(GetForegroundWindow()); return t.StartsWith("EVE - ") ? t.Substring(6).Trim() : null; }
  public static void CopyAll() {
    const uint UP = 2;
    foreach (int vk in new[] { 0x10, 0x11, 0x12 }) if ((GetAsyncKeyState(vk) & 0x8000) != 0) keybd_event((byte)vk, 0, UP, UIntPtr.Zero);
    int[,] seq = { { 0x11, 0 }, { 0x41, 0 }, { 0x41, 2 }, { 0x43, 0 }, { 0x43, 2 }, { 0x11, 2 } };
    for (int i = 0; i < 6; i++) { keybd_event((byte)seq[i, 0], 0, (uint)seq[i, 1], UIntPtr.Zero); System.Threading.Thread.Sleep(30); }
  }
}
'@
try { if (-not [HR]::SetProcessDpiAwarenessContext([IntPtr](-4))) { [void][HR]::SetProcessDPIAware() } } catch { [void][HR]::SetProcessDPIAware() }
$null = [Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics,ContentType=WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, $t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
$ocr = $null
function Get-Ocr {
  if ($script:ocr -eq $null) {
    # Prefer English OCR; the Language type has to be loaded explicitly in Windows PowerShell.
    try {
      $null = [Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime]
      $script:ocr = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language 'en-US'))
    } catch { $script:ocr = $null }
    # Fallback: whatever OCR language Windows has (Norwegian etc. read EVE's Latin names fine)
    if ($script:ocr -eq $null) { $script:ocr = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
    if ($script:ocr -eq $null) { throw "Windows has no OCR language installed (Settings > Time & language > Language: add English)" }
  }
  $script:ocr
}
function Read-Rect($x, $y, $w, $h, $out) {
  $src = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($src); $g.CopyFromScreen($x, $y, 0, 0, $src.Size); $g.Dispose()
  $S = 3
  $big = New-Object System.Drawing.Bitmap ($w*$S), ($h*$S)
  $g = [System.Drawing.Graphics]::FromImage($big)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $cm = New-Object System.Drawing.Imaging.ColorMatrix
  $cm.Matrix00 = -1; $cm.Matrix11 = -1; $cm.Matrix22 = -1; $cm.Matrix40 = 1; $cm.Matrix41 = 1; $cm.Matrix42 = 1
  $ia = New-Object System.Drawing.Imaging.ImageAttributes; $ia.SetColorMatrix($cm)
  $g.DrawImage($src, (New-Object System.Drawing.Rectangle 0, 0, ($w*$S), ($h*$S)), 0, 0, $w, $h, [System.Drawing.GraphicsUnit]::Pixel, $ia)
  $g.Dispose(); $big.Save($out, [System.Drawing.Imaging.ImageFormat]::Png); $big.Dispose(); $src.Dispose()
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($out)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bmp = Await ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $res = Await ((Get-Ocr).RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
  $stream.Dispose()
  ,@($res.Lines | ForEach-Object {
    $ys = @($_.Words | ForEach-Object { $_.BoundingRect.Y + $_.BoundingRect.Height / 2 })
    @{ t = $_.Text; y = [math]::Round((($ys | Measure-Object -Average).Average) / $S, 1) }
  })
}
function Out-Json($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress -Depth 4)); [Console]::Out.Flush() }

Out-Json @{ ready = $true }
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $p = $line.Split(' ')
  try {
    switch ($p[0]) {
      'WIN' { Out-Json @{ titles = @([HR]::EveTitles()); fg = [HR]::Foreground(); clicks = @([MidClick]::Drain()) } }
      'KEYS' { [HR]::CopyAll(); Out-Json @{ ok = $true } }
      'OCR' {
        $r = Read-Rect ([int]$p[1]) ([int]$p[2]) ([int]$p[3]) ([int]$p[4]) ($p[5..($p.Length-1)] -join ' ')
        Out-Json @{ lines = @($r | ForEach-Object { $_.t }) }
      }
      'OCRL' {
        $r = Read-Rect ([int]$p[1]) ([int]$p[2]) ([int]$p[3]) ([int]$p[4]) ($p[5..($p.Length-1)] -join ' ')
        Out-Json @{ lines = @($r) }
      }
      'HOOK' { if ($p[1] -eq 'ON') { [MidClick]::On() } else { [MidClick]::Off() }; Out-Json @{ ok = $true } }
      default { Out-Json @{ error = "unknown command" } }
    }
  } catch { Out-Json @{ error = $_.Exception.Message } }
}
