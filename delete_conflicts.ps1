$INFLUX_URL  = 'http://10.0.0.45:8086'
$INFLUX_TOKEN = 'T6M0gntRz3BX-q_huEoxfe11-raaAG-DKd-Byz1uMioSHw8OPsoPdpH5eY5o7RtgwY_vrhMo56lOVsWm1fVQXA=='
$INFLUX_ORG  = 'RotaHotspot'
$BUCKET      = 'monitor'

$predicates = @(
    '_measurement="interface_stats" AND _field="mtu"',
    '_measurement="system_resource" AND _field="factory_software"'
)

foreach ($pred in $predicates) {
    $body = @{ start = '1970-01-01T00:00:00Z'; stop = (Get-Date).ToString('o'); predicate = $pred } | ConvertTo-Json
    Invoke-RestMethod -Method Post -Uri "$INFLUX_URL/api/v2/delete?org=$([Uri]::EscapeDataString($INFLUX_ORG))&bucket=$([Uri]::EscapeDataString($BUCKET))" `
      -Headers @{ Authorization = "Token $INFLUX_TOKEN"; 'Content-Type' = 'application/json' } -Body $body
    Write-Host "Delete enviado para: $pred"
}