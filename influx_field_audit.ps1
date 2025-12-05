$INFLUX_URL = "http://10.0.0.45:8086"
$INFLUX_TOKEN = "T6M0gntRz3BX-q_huEoxfe11-raaAG-DKd-Byz1uMioSHw8OPsoPdpH5eY5o7RtgwY_vrhMo56lOVsWm1fVQXA=="
$INFLUX_ORG = "RotaHotspot"
$BUCKET = "monitoring"

function Run-FluxCsv {
    param($flux)
    $uri = "$INFLUX_URL/api/v2/query?org=$([Uri]::EscapeDataString($INFLUX_ORG))"
    try {
        $resp = Invoke-RestMethod -Method Post -Uri $uri -Headers @{
            Authorization = "Token $INFLUX_TOKEN"
            Accept = "application/csv"
            "Content-Type" = "application/vnd.flux"
        } -Body $flux -ErrorAction Stop
        return $resp -as [string]
    } catch {
        Write-Error "Flux query failed: $($_.Exception.Message)"; return $null
    }
}

function Extract-Value {
    param($line)
    $parts = $line -split ','
    return $parts[-1].Trim()
}

# Listar medições
$flux = @"
import "influxdata/influxdb/schema"
schema.measurements(bucket: "$BUCKET", start: 1970-01-01T00:00:00Z)
"@
$csv = Run-FluxCsv -flux $flux

if (-not $csv) {
    Write-Host "Falha ao obter medições."
    exit 1
}

$lines = $csv -split "`r?`n"
$measurements = @()
foreach ($line in $lines) {
    if ($line -ne "" -and $line -notmatch '^,result,table') {
        $value = Extract-Value -line $line
        if ($value -ne "" -and $value -notmatch '^\s*_') {
            $measurements += $value
        }
    }
}

if ($measurements.Count -eq 0) {
    Write-Host "Nenhuma medição encontrada."
    exit 0
}

Write-Host "Medições encontradas: $($measurements -join ', ')"
Write-Host "`nAuditando fields...`n"

$report = @()

foreach ($m in $measurements) {
    Write-Host "Medição: $m"
    
    $fluxFields = @"
from(bucket: "$BUCKET")
  |> range(start: -7d)
  |> filter(fn: (r) => r._measurement == "$m")
  |> keep(columns: ["_field"])
  |> distinct(column: "_field")
"@
    $csvF = Run-FluxCsv -flux $fluxFields
    if (-not $csvF) {
        Write-Host "  Falha ao obter fields"
        continue
    }

    $fieldsLines = $csvF -split "`r?`n"
    $fields = @()
    foreach ($line in $fieldsLines) {
        if ($line -ne "" -and $line -notmatch '^,result,table') {
            $field = Extract-Value -line $line
            if ($field -ne "" -and $field -notmatch '^\s*_') {
                $fields += $field
            }
        }
    }

    if ($fields.Count -eq 0) {
        Write-Host "  Nenhum field encontrado"
    } else {
        foreach ($f in $fields) {
            Write-Host "  Field: $f"
            $report += [pscustomobject]@{
                measurement = $m
                field = $f
            }
        }
    }
}

Write-Host "`nResumo:"
$report | Format-Table -AutoSize