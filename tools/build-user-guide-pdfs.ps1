# Builds the User Guide PDFs from the HTML guides, using Microsoft Edge (or Chrome) in the background.
# Run from the zetclass folder:  powershell -ExecutionPolicy Bypass -File tools\build-user-guide-pdfs.ps1
$root = Join-Path (Split-Path $PSScriptRoot -Parent) 'User Guide'
$out  = Join-Path $root 'PDF'
New-Item -ItemType Directory -Force $out | Out-Null
$browser = @('C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe', 'C:\Program Files\Microsoft\Edge\Application\msedge.exe', 'C:\Program Files\Google\Chrome\Application\chrome.exe') | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $browser) { throw 'Edge or Chrome was not found.' }
$jobs = @(
  @('00 Start Here.html',                                                        'Zetclass User Guide - 0 Start Here.pdf'),
  @('01 Everyday Sign-In (All Users).html',                                      'Zetclass User Guide - 1 Everyday Sign-In.pdf'),
  @('02 School Admin - Register and Set Up.html',                                'Zetclass User Guide - 2 School Admin.pdf'),
  @('03 App Admin (Owner)\03 App Admin - Owner Control Room.html',               'Zetclass User Guide - 3 Owner Control Room.pdf'),
  @('03 App Admin (Owner)\03b SPECIAL - Where School Data Is Saved.html',        'Zetclass User Guide - 3b Where School Data Is Saved.pdf')
)
$profile = Join-Path $env:TEMP 'zetclass-pdf-profile'
$errFile = Join-Path $env:TEMP 'zetclass-pdf-err.txt'
foreach ($j in $jobs) {
  $src = Join-Path $root $j[0]
  $dst = Join-Path $out  $j[1]
  $uri = ([System.Uri]$src).AbsoluteUri
  if (Test-Path $dst) { Remove-Item $dst -Force }
  $argList = @('--headless=new', '--disable-gpu', '--no-pdf-header-footer', "--user-data-dir=`"$profile`"", "--print-to-pdf=`"$dst`"", "`"$uri`"")
  Start-Process -FilePath $browser -ArgumentList $argList -Wait -NoNewWindow -RedirectStandardError $errFile | Out-Null
  $deadline = (Get-Date).AddSeconds(40)
  while (-not (Test-Path $dst) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
  if (Test-Path $dst) { '{0,-62} {1,8} KB' -f $j[1], [int]((Get-Item $dst).Length / 1KB) } else { "FAILED: $($j[1])" }
}
