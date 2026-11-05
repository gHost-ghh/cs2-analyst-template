param([string]$Message = 'Choose the original CS2 Demo for this match')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = $Message
$dialog.Filter = 'CS2 Demo (*.dem)|*.dem'
$dialog.CheckFileExists = $true
$dialog.Multiselect = $false
if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { throw 'No original Demo selected' }
@{ file = $dialog.FileName } | ConvertTo-Json -Compress
