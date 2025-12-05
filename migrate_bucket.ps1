# --- Detalhes da Conexão com InfluxDB ---
$INFLUX_URL = "http://10.0.0.45:8086"
$INFLUX_TOKEN = "T6M0gntRz3BX-q_huEoxfe11-raaAG-DKd-Byz1uMioSHw8OPsoPdpH5eY5o7RtgwY_vrhMo56lOVsWm1fVQXA=="
$INFLUX_ORG = "RotaHotspot"
$BUCKET = "monitoring"

Write-Host "--- INICIANDO SCRIPT DE LIMPEZA DE BUCKET ---"
Write-Host "A conectar-se ao bucket '$BUCKET'..."
Write-Host ""

# Lista de medições a serem completamente apagadas para resolver conflitos de tipo
$measurementsToDelete = @(
    "interface_stats", 
    "system_resource", 
    "ip_dhcp-server_lease", 
    "ip_arp", 
    "system_clock", 
    "system_health", 
    "user", 
    "ip_address"
)

foreach ($measurement in $measurementsToDelete) {
    $body = @{ 
        start     = "1970-01-01T00:00:00Z"
        stop      = (Get-Date).ToUniversalTime().ToString("o") # Usa o formato UTC padrão
        predicate = '_measurement="{0}"' -f $measurement
    } | ConvertTo-Json
    
    try {
        $splatParams = @{
            Method      = 'Post'
            Uri         = "$INFLUX_URL/api/v2/delete?org=$([Uri]::EscapeDataString($INFLUX_ORG))&bucket=$([Uri]::EscapeDataString($BUCKET))"
            Headers     = @{ Authorization = "Token $INFLUX_TOKEN"; 'Content-Type' = 'application/json' }
            Body        = $body
            ErrorAction = 'Stop'
        }
        Invoke-RestMethod @splatParams
        Write-Host "✓ SUCESSO: Medição '$measurement' foi limpa."
    } catch {
        Write-Host "✗ ERRO ao limpar '$measurement': $($_.Exception.Message)"
    }
}

Write-Host ""
Write-Host "--- SCRIPT DE LIMPEZA CONCLUÍDO ---"
Write-Host "Pode reiniciar o 'monitoring-agent' agora."