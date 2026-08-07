'use strict';

function validateVolume(value) {
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new Error('Volume must be an integer between 0 and 100.');
  }

  return value;
}

function validateProcessId(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error('A valid process ID is required for volume control.');
  }

  return pid;
}

function buildVolumeScript(pid, volume) {
  const validatedPid = validateProcessId(pid);
  const volumeFloat = (validateVolume(volume) / 100).toFixed(4);
  const csharpCode = `using System;
using System.Runtime.InteropServices;
public class VolumeMixer {
    public static bool SetVolume(int pid, float level) {
        try {
            IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
            IMMDevice device;
            enumerator.GetDefaultAudioEndpoint(0, 1, out device);
            Guid iid = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
            object activatedObject;
            device.Activate(ref iid, 23, IntPtr.Zero, out activatedObject);
            IAudioSessionManager2 manager = (IAudioSessionManager2)activatedObject;
            IAudioSessionEnumerator sessions;
            if (manager.GetSessionEnumerator(out sessions) < 0) return false;
            int count;
            if (sessions.GetCount(out count) < 0) return false;
            for (int i = 0; i < count; i++) {
                IAudioSessionControl2 control;
                if (sessions.GetSession(i, out control) < 0) return false;
                int processId;
                if (control.GetProcessId(out processId) < 0) return false;
                if (processId == pid) {
                    ISimpleAudioVolume sessionVolume = (ISimpleAudioVolume)control;
                    Guid eventContext = Guid.Empty;
                    return sessionVolume.SetMasterVolume(level, ref eventContext) == 0;
                }
            }
            return false;
        } catch {
            return false;
        }
    }
}
[ComImport][Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")][ClassInterface(ClassInterfaceType.None)]
internal class MMDeviceEnumerator {}
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")][InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F")][InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int context, IntPtr activationParameters, [MarshalAs(UnmanagedType.IUnknown)] out object activatedObject);
}
[Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F")][InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IAudioSessionManager2 {
    [PreserveSig] int GetAudioSessionControl(IntPtr audioSessionGuid, int streamFlags, out IntPtr sessionControl);
    [PreserveSig] int GetSimpleAudioVolume(IntPtr audioSessionGuid, int streamFlags, out IntPtr simpleAudioVolume);
    [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator sessions);
    [PreserveSig] int RegisterSessionNotification(IntPtr notification);
    [PreserveSig] int UnregisterSessionNotification(IntPtr notification);
    [PreserveSig] int RegisterDuckNotification(IntPtr sessionId, IntPtr notification);
    [PreserveSig] int UnregisterDuckNotification(IntPtr notification);
}
[Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8")][InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IAudioSessionEnumerator {
    [PreserveSig] int GetCount(out int sessionCount);
    [PreserveSig] int GetSession(int sessionIndex, out IAudioSessionControl2 session);
}
[Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d")][InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IAudioSessionControl2 {
    [PreserveSig] int NotImpl1(); [PreserveSig] int NotImpl2(); [PreserveSig] int NotImpl3();
    [PreserveSig] int NotImpl4(); [PreserveSig] int NotImpl5(); [PreserveSig] int NotImpl6();
    [PreserveSig] int NotImpl7(); [PreserveSig] int NotImpl8(); [PreserveSig] int NotImpl9();
    [PreserveSig] int NotImpl10(); [PreserveSig] int NotImpl11();
    [PreserveSig] int GetProcessId(out int processId);
}
[Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8")][InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface ISimpleAudioVolume {
    [PreserveSig] int SetMasterVolume(float level, ref Guid eventContext);
    [PreserveSig] int GetMasterVolume(out float level);
    [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid eventContext);
    [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
}`;

  return `$ErrorActionPreference = 'Stop'
$TargetPid = ${validatedPid}
$TargetVol = [float]${volumeFloat}
Add-Type -TypeDefinition @'
${csharpCode}
'@
if (-not [VolumeMixer]::SetVolume($TargetPid, $TargetVol)) {
  [Console]::Error.WriteLine('No matching audio session was updated.')
  exit 1
}
[Console]::Out.WriteLine('VOLUME_UPDATED')
`;
}

// PowerShell serializes stderr as CLIXML when it is redirected, so the raw
// stream is an unreadable XML blob wrapped around the real message. Recover the
// human-readable text so failures can be surfaced in the UI.
function readPowerShellError(stderr) {
  const raw = String(stderr || '');
  if (!raw.trim()) {
    return '';
  }
  if (!raw.includes('#< CLIXML')) {
    return raw.trim();
  }
  return raw
    .replace('#< CLIXML', '')
    .replace(/<Objs[\s\S]*?<\/Objs>/g, '')
    .replace(/<[^>]*>/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .trim();
}

// The Windows audio session for a process does not exist until that process
// actually starts playing, so a "no matching session" result right after launch
// is a timing miss rather than a real failure.
function isMissingAudioSession(result) {
  return result?.success === false
    && /no matching audio session/i.test(String(result.error || ''));
}

function createVolumeProcessResult(error, stdout, stderr) {
  if (error) {
    const message = readPowerShellError(stderr) || error.message || 'PowerShell failed to update volume.';
    return { success: false, error: message };
  }

  if (String(stdout || '').trim() !== 'VOLUME_UPDATED') {
    return { success: false, error: 'Volume update was not confirmed by PowerShell.' };
  }

  return { success: true };
}

module.exports = {
  buildVolumeScript,
  createVolumeProcessResult,
  isMissingAudioSession,
  readPowerShellError,
  validateProcessId,
  validateVolume
};
