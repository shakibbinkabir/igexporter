# Regenerates the IG Exporter icon set.
# Usage:  powershell -ExecutionPolicy Bypass -File icons/build.ps1
# Output: icons/icon16.png, icon48.png, icon128.png, icon256.png

Add-Type -AssemblyName System.Drawing

function New-IGExporterIcon {
    param(
        [Parameter(Mandatory)][int]$Size,
        [Parameter(Mandatory)][string]$OutPath
    )

    $bmp = New-Object System.Drawing.Bitmap(
        $Size, $Size,
        [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)

    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode      = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode    = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.InterpolationMode  = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    # --- Background: rounded square ---
    $corner = $Size * 0.225
    $d      = $corner * 2
    $bg     = New-Object System.Drawing.Drawing2D.GraphicsPath
    $bg.AddArc(0,             0,             $d, $d, 180, 90) | Out-Null
    $bg.AddArc($Size - $d,    0,             $d, $d, 270, 90) | Out-Null
    $bg.AddArc($Size - $d,    $Size - $d,    $d, $d,   0, 90) | Out-Null
    $bg.AddArc(0,             $Size - $d,    $d, $d,  90, 90) | Out-Null
    $bg.CloseFigure()

    # Instagram brand gradient (yellow -> orange -> pink -> purple -> blue-violet),
    # rotated 135deg so warm tones sit bottom-left and cool tones top-right.
    $rect = New-Object System.Drawing.RectangleF(0, 0, $Size, $Size)
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        $rect,
        [System.Drawing.Color]::White,
        [System.Drawing.Color]::White,
        [single]135)

    $blend = New-Object System.Drawing.Drawing2D.ColorBlend(5)
    $blend.Colors = @(
        [System.Drawing.Color]::FromArgb(255, 254, 218, 119),  # #FEDA77
        [System.Drawing.Color]::FromArgb(255, 245, 133,  41),  # #F58529
        [System.Drawing.Color]::FromArgb(255, 221,  42, 123),  # #DD2A7B
        [System.Drawing.Color]::FromArgb(255, 129,  52, 175),  # #8134AF
        [System.Drawing.Color]::FromArgb(255,  81,  91, 212)   # #515BD4
    )
    $blend.Positions = @(0.0, 0.28, 0.55, 0.80, 1.0)
    $brush.InterpolationColors = $blend

    $g.FillPath($brush, $bg)

    # --- Foreground: clean download glyph (arrow + tray) ---
    # Scales gracefully to 16x16. Pure white on the gradient reads strongly.
    $cx = $Size / 2.0
    $cy = $Size / 2.0

    # Stroke thickness scales with size; slightly heavier at small sizes
    # so the glyph survives anti-aliasing at 16x16.
    $stroke = if ($Size -le 24) { $Size * 0.13 } else { $Size * 0.10 }
    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, [single]$stroke)
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

    # Arrow shaft
    $shaftTop    = $cy - $Size * 0.22
    $shaftBottom = $cy + $Size * 0.10
    $g.DrawLine($pen,
        [single]$cx, [single]$shaftTop,
        [single]$cx, [single]$shaftBottom)

    # Chevron tip
    $chevW = $Size * 0.135
    $chevH = $Size * 0.12
    $g.DrawLine($pen,
        [single]($cx - $chevW), [single]($shaftBottom - $chevH),
        [single]$cx,             [single]$shaftBottom)
    $g.DrawLine($pen,
        [single]($cx + $chevW), [single]($shaftBottom - $chevH),
        [single]$cx,             [single]$shaftBottom)

    # Tray (the "download into" line)
    $trayY     = $cy + $Size * 0.27
    $trayHalfW = $Size * 0.21
    $g.DrawLine($pen,
        [single]($cx - $trayHalfW), [single]$trayY,
        [single]($cx + $trayHalfW), [single]$trayY)

    $brush.Dispose()
    $pen.Dispose()
    $bg.Dispose()
    $g.Dispose()

    $bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "  wrote $OutPath ($Size x $Size)"
}

$dir = $PSScriptRoot
Write-Host "Generating IG Exporter icons into $dir"
New-IGExporterIcon -Size  16 -OutPath (Join-Path $dir 'icon16.png')
New-IGExporterIcon -Size  48 -OutPath (Join-Path $dir 'icon48.png')
New-IGExporterIcon -Size 128 -OutPath (Join-Path $dir 'icon128.png')
New-IGExporterIcon -Size 256 -OutPath (Join-Path $dir 'icon256.png')
Write-Host "Done."
