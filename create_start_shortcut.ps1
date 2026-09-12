# Build frontend
Write-Host "Building Concaretti frontend..."
Set-Location -Path "frontend"
npm install
npm run build
Set-Location -Path ".."

# Create Start Menu shortcut
Write-Host "Creating Start Menu shortcut..."
$WshShell = New-Object -ComObject WScript.Shell
$StartMenu = [System.Environment]::GetFolderPath('StartMenu')
$ShortcutPath = Join-Path -Path $StartMenu -ChildPath "Programs\Concaretti.lnk"
$Shortcut = $WshShell.CreateShortcut($ShortcutPath)

$WorkspaceRoot = (Get-Item -Path ".\").FullName
$VbsPath = Join-Path -Path $WorkspaceRoot -ChildPath "ConcarettiLauncher.vbs"
$IconPath = Join-Path -Path $WorkspaceRoot -ChildPath "council.png"

$Shortcut.TargetPath = "wscript.exe"
$Shortcut.Arguments = "`"$VbsPath`""
$Shortcut.WorkingDirectory = $WorkspaceRoot
$Shortcut.Description = "Concaretti Desktop UI"
if (Test-Path $IconPath) {
    $Shortcut.IconLocation = $IconPath
}
$Shortcut.Save()

Write-Host "Done! Concaretti shortcut created in Start Menu."
