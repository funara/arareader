# Generates Windows multi-resolution .ico files from public PNG assets.
#
# Generates:
# - apps/desktop/build/icon.ico from public/ARAReader-icon.png
# - apps/desktop/build/pdf.ico from public/ARAPdf-icon.png
#
# Frames: 16x16, 24x24, 32x32, 48x48, 64x64, 128x128, 256x256 (PNG format)

param(
    [string]$RepoRoot = (Resolve-Path "$PSScriptRoot/..").Path
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

function Convert-PngToIco {
    param(
        [Parameter(Mandatory=$true)][string]$InputPng,
        [Parameter(Mandatory=$true)][string]$OutputIco
    )

    if (-not (Test-Path $InputPng)) {
        throw "Input PNG not found: $InputPng"
    }

    $src = [System.Drawing.Bitmap]::FromFile($InputPng)
    $sizes = @(16, 24, 32, 48, 64, 128, 256)
    $pngBuffers = [System.Collections.Generic.List[byte[]]]::new()

    foreach ($size in $sizes) {
        $dest = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $g = [System.Drawing.Graphics]::FromImage($dest)
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $g.Clear([System.Drawing.Color]::Transparent)
        $g.DrawImage($src, 0, 0, $size, $size)
        $g.Dispose()

        $ms = [System.IO.MemoryStream]::new()
        $dest.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        $dest.Dispose()
        $pngBuffers.Add($ms.ToArray())
        $ms.Dispose()
    }
    $src.Dispose()

    $outDir = Split-Path -Parent $OutputIco
    if (-not (Test-Path $outDir)) {
        New-Item -ItemType Directory -Path $outDir -Force | Out-Null
    }

    $fs = [System.IO.File]::Create($OutputIco)
    $bw = [System.IO.BinaryWriter]::new($fs)

    # ICONDIR header: 6 bytes
    $bw.Write([uint16]0) # Reserved
    $bw.Write([uint16]1) # Type: 1 = ICO
    $bw.Write([uint16]$sizes.Count) # Image count

    # Starting offset for image bytes: 6 + (16 * count)
    $offset = 6 + (16 * $sizes.Count)

    for ($i = 0; $i -lt $sizes.Count; $i++) {
        $size = $sizes[$i]
        $b = if ($size -ge 256) { [byte]0 } else { [byte]$size }
        $buf = $pngBuffers[$i]

        $bw.Write($b)                 # Width
        $bw.Write($b)                 # Height
        $bw.Write([byte]0)            # Color count (0 = >=8bpp)
        $bw.Write([byte]0)            # Reserved
        $bw.Write([uint16]1)          # Planes
        $bw.Write([uint16]32)         # BitCount
        $bw.Write([uint32]$buf.Length)# BytesInRes
        $bw.Write([uint32]$offset)    # ImageOffset

        $offset += $buf.Length
    }

    foreach ($buf in $pngBuffers) {
        $bw.Write($buf)
    }

    $bw.Close()
    $fs.Close()
    Write-Host "Generated $OutputIco from $(Split-Path $InputPng -Leaf)"
}

$appIconSource = Join-Path $RepoRoot "public/ARAReader-icon.png"
$appIconDest   = Join-Path $RepoRoot "apps/desktop/build/icon.ico"

$pdfIconSource = Join-Path $RepoRoot "public/ARAPdf-icon.png"
$pdfIconDest   = Join-Path $RepoRoot "apps/desktop/build/pdf.ico"

Convert-PngToIco -InputPng $appIconSource -OutputIco $appIconDest
Convert-PngToIco -InputPng $pdfIconSource -OutputIco $pdfIconDest
