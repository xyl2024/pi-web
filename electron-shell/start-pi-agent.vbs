' start-pi-agent.vbs — launch Pi Agent Electron shell with no console window
' Double-click to test. Then drop a shortcut into shell:startup for auto-start.

Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

electronExe = scriptDir & "\node_modules\electron\dist\electron.exe"
If Not fso.FileExists(electronExe) Then
    MsgBox "electron.exe not found." & vbCrLf & "Run: cd " & scriptDir & " && npm install", 48, "Pi Agent"
    WScript.Quit 1
End If

Set shell = CreateObject("WScript.Shell")
' Run(command, windowStyle, waitOnReturn)
' windowStyle: 0 = hidden, 1 = normal, 2 = minimized
shell.Run """" & electronExe & """ """ & scriptDir & """ --hidden", 0, False
