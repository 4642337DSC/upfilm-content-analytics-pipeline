' Bind this file (not start-hidden.bat directly) to a keyboard macro / G-key
' as "Launch Application" - it runs start-hidden.bat with no visible window
' and no taskbar flash, then the server opens the browser tab itself.
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
Set shell = CreateObject("WScript.Shell")
shell.Run """" & scriptDir & "\start-hidden.bat""", 0, False
