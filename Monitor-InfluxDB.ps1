# ================================================
# InfluxDB-Monitor.ps1
# Script completo para monitorar InfluxDB - RotaHotspot
# ================================================

# CONFIGURAÇÕES DO SEU AMBIENTE
$InfluxDB_URL = "http://10.0.0.45:8086"
$InfluxDB_Token = "T6M0gntRz3BX-q_huEoxfe11-raaAG-DKd-Byz1uMioSHw8OPsoPdpH5eY5o7RtgwY_vrhMo56lOVsWm1fVQXA=="
$InfluxDB_Org = "RotaHotspot"
$InfluxDB_Bucket = "monitor"

# Função para escrever logs
function Write-Log {
    param([string]$Message, [string]$Color = "White")
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] $Message" -ForegroundColor $Color
}

# Função para testar conexão
function Test-Connection {
    Write-Log "Testando conexao com InfluxDB..." "Yellow"
    Write-Log "URL: $InfluxDB_URL" "Gray"
    Write-Log "Org: $InfluxDB_Org" "Gray"
    Write-Log "Bucket: $InfluxDB_Bucket" "Gray"
    
    try {
        $headers = @{
            "Authorization" = "Token $InfluxDB_Token"
            "Content-Type" = "application/json"
        }
        
        $response = Invoke-RestMethod -Uri "$InfluxDB_URL/health" -Headers $headers -Method GET -ErrorAction Stop
        
        Write-Log "SUCESSO: Conexao estabelecida!" "Green"
        Write-Log "Status: $($response.status)" "Cyan"
        Write-Log "Versao: $($response.version)" "Cyan"
        return $true
    }
    catch {
        Write-Log "FALHA NA CONEXAO" "Red"
        Write-Log "Erro: $($_.Exception.Message)" "Red"
        return $false
    }
}

# Função para executar queries
function Execute-Query {
    param([string]$Query)
    
    $body = @{
        query = $Query
        dialect = @{
            header = $true
            delimiter = ","
            annotations = @("datatype", "group", "default")
        }
    } | ConvertTo-Json -Depth 10
    
    $headers = @{
        "Authorization" = "Token $InfluxDB_Token"
        "Content-Type" = "application/json"
        "Accept" = "application/csv"
    }
    
    try {
        $response = Invoke-RestMethod `
            -Uri "$InfluxDB_URL/api/v2/query?org=$InfluxDB_Org" `
            -Headers $headers `
            -Method POST `
            -Body $body `
            -ErrorAction Stop `
            -TimeoutSec 10
        
        if ($response -and $response.Trim() -ne "") {
            return $response | ConvertFrom-Csv
        }
        else {
            return @()
        }
    }
    catch {
        Write-Log "Erro na query: $($_.Exception.Message)" "Red"
        return @()
    }
}

# Função para listar measurements
function List-Measurements {
    Write-Log "Listando measurements do bucket '$InfluxDB_Bucket'..." "Yellow"
    
    $query = 'import "influxdata/influxdb/schema"'
    $query += "`n" + 'schema.measurements(bucket: "' + $InfluxDB_Bucket + '")'
    
    $measurements = Execute-Query -Query $query
    
    if ($measurements.Count -eq 0) {
        Write-Log "Nenhuma measurement encontrada." "Red"
        return @()
    }
    
    Write-Log "Encontradas $($measurements.Count) measurements:" "Green"
    return $measurements
}

# Função para mostrar detalhes de uma measurement
function Show-Measurement-Details {
    param([string]$MeasurementName)
    
    Write-Host ""
    Write-Host "Detalhes da measurement: $MeasurementName" -ForegroundColor Cyan
    Write-Host "----------------------------------------" -ForegroundColor Cyan
    
    # Buscar campos
    $fieldsQuery = 'import "influxdata/influxdb/schema"'
    $fieldsQuery += "`n" + 'schema.fieldKeys('
    $fieldsQuery += "`n  bucket: `"" + $InfluxDB_Bucket + "`","
    $fieldsQuery += "`n  predicate: (r) => r._measurement == `"" + $MeasurementName + "`""
    $fieldsQuery += "`n)"
    
    $fields = Execute-Query -Query $fieldsQuery
    
    # Buscar tags
    $tagsQuery = 'import "influxdata/influxdb/schema"'
    $tagsQuery += "`n" + 'schema.tagKeys('
    $tagsQuery += "`n  bucket: `"" + $InfluxDB_Bucket + "`","
    $tagsQuery += "`n  predicate: (r) => r._measurement == `"" + $MeasurementName + "`""
    $tagsQuery += "`n)"
    
    $tags = Execute-Query -Query $tagsQuery
    
    Write-Host "Campos ($($fields.Count)):" -ForegroundColor Green
    foreach ($field in $fields) {
        Write-Host "  - $($field._value)" -ForegroundColor Gray
    }
    
    Write-Host ""
    Write-Host "Tags ($($tags.Count)):" -ForegroundColor Green
    foreach ($tag in $tags) {
        Write-Host "  - $($tag._value)" -ForegroundColor Gray
    }
    
    # Buscar exemplo de dados
    $sampleQuery = 'from(bucket: "' + $InfluxDB_Bucket + '")'
    $sampleQuery += "`n" + '  |> range(start: -1h)'
    $sampleQuery += "`n" + '  |> filter(fn: (r) => r._measurement == "' + $MeasurementName + '")'
    $sampleQuery += "`n" + '  |> limit(n: 1)'
    
    $sample = Execute-Query -Query $sampleQuery
    
    if ($sample.Count -gt 0) {
        Write-Host ""
        Write-Host "Exemplo de dados:" -ForegroundColor Green
        $sample | Select-Object -First 1 | Format-List
    }
}

# Função para monitorar em tempo real
function Monitor-Realtime {
    Write-Host ""
    Write-Host "MONITORAMENTO EM TEMPO REAL" -ForegroundColor Cyan
    Write-Host "============================" -ForegroundColor Cyan
    Write-Host "Bucket: $InfluxDB_Bucket" -ForegroundColor Yellow
    Write-Host "Pressione Ctrl+C para parar" -ForegroundColor Red
    Write-Host ""
    
    $startTime = Get-Date
    
    try {
        while ($true) {
            Clear-Host
            
            Write-Host "Monitorando: $(Get-Date -Format 'HH:mm:ss')" -ForegroundColor Cyan
            Write-Host "Bucket: $InfluxDB_Bucket" -ForegroundColor Yellow
            Write-Host "----------------------------------------" -ForegroundColor DarkCyan
            
            # Query para dados dos últimos 30 segundos
            $query = 'from(bucket: "' + $InfluxDB_Bucket + '")'
            $query += "`n" + '  |> range(start: -30s)'
            $query += "`n" + '  |> group(columns: ["_measurement", "router_host"])'
            $query += "`n" + '  |> count()'
            $query += "`n" + '  |> sort(columns: ["_value"], desc: true)'
            $query += "`n" + '  |> limit(n: 10)'
            
            $data = Execute-Query -Query $query
            
            if ($data.Count -gt 0) {
                Write-Host "Dados recebidos nos ultimos 30s:" -ForegroundColor Green
                Write-Host ""
                
                foreach ($row in $data) {
                    $measurement = $row._measurement
                    $router = $row.router_host
                    $count = $row._value
                    
                    Write-Host "  $measurement" -ForegroundColor Cyan -NoNewline
                    Write-Host " @ " -ForegroundColor Gray -NoNewline
                    Write-Host "$router" -ForegroundColor Yellow -NoNewline
                    Write-Host " = " -ForegroundColor Gray -NoNewline
                    Write-Host "$count registros" -ForegroundColor Green
                }
            }
            else {
                Write-Host "Nenhum dado recebido nos ultimos 30 segundos." -ForegroundColor Yellow
            }
            
            Write-Host ""
            Write-Host "Tempo de monitoramento: $((Get-Date) - $startTime)" -ForegroundColor Gray
            Write-Host "Proxima atualizacao em 5 segundos..." -ForegroundColor Gray
            Write-Host "Pressione Ctrl+C para parar" -ForegroundColor Red
            
            Start-Sleep -Seconds 5
        }
    }
    catch {
        Write-Host ""
        Write-Log "Monitoramento interrompido." "Yellow"
    }
}

# Função para mostrar mapeamento API
function Show-APIMapping {
    Write-Host ""
    Write-Host "MAPEAMENTO INFLUXDB -> SUA API" -ForegroundColor Cyan
    Write-Host "================================" -ForegroundColor Cyan
    
    $mapping = @(
        @{InfluxDB="system_resource"; API="/api/monitoring/router/{id}/metrics"; Desc="Metricas do sistema (CPU, memoria, uptime)"},
        @{InfluxDB="interface_stats"; API="/api/monitoring/router/{id}/interface-traffic"; Desc="Trafego de rede por interface"},
        @{InfluxDB="ip_dhcp_server_lease"; API="/api/monitoring/router/{id}/clients"; Desc="Clientes DHCP"},
        @{InfluxDB="interface_wireless_registration_table"; API="/api/monitoring/router/{id}/clients"; Desc="Clientes Wi-Fi"},
        @{InfluxDB="hotspot_active"; API="/api/monitoring/router/{id}/clients"; Desc="Clientes Hotspot"}
    )
    
    Write-Host ""
    Write-Host "Como chamar na sua aplicacao:" -ForegroundColor White
    Write-Host ""
    
    foreach ($item in $mapping) {
        Write-Host "INFLUXDB: $($item.InfluxDB)" -ForegroundColor Yellow
        Write-Host "SUA API:  $($item.API)" -ForegroundColor Green
        Write-Host "DESCRICAO: $($item.Desc)" -ForegroundColor Gray
        Write-Host ""
    }
    
    Write-Host "EXEMPLOS:" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "1. Status de todos roteadores:" -ForegroundColor White
    Write-Host "   GET /api/monitoring/all-routers-status" -ForegroundColor Green
    Write-Host ""
    Write-Host "2. Metricas de um roteador:" -ForegroundColor White
    Write-Host "   GET /api/monitoring/router/1/metrics?range=24h" -ForegroundColor Green
    Write-Host ""
    Write-Host "3. Clientes conectados:" -ForegroundColor White
    Write-Host "   GET /api/monitoring/router/1/clients" -ForegroundColor Green
    Write-Host ""
    Write-Host "4. Trafego de interface:" -ForegroundColor White
    Write-Host "   GET /api/monitoring/router/1/interface-traffic?interface=ether1&range=15m" -ForegroundColor Green
}

# Menu principal
function Show-Menu {
    Clear-Host
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host " MONITORADOR INFLUXDB - ROTAHOTSPOT" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "URL: $InfluxDB_URL" -ForegroundColor Gray
    Write-Host "Bucket: $InfluxDB_Bucket" -ForegroundColor Gray
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "1. Testar conexao" -ForegroundColor White
    Write-Host "2. Listar measurements" -ForegroundColor White
    Write-Host "3. Monitorar em tempo real" -ForegroundColor White
    Write-Host "4. Ver mapeamento API" -ForegroundColor White
    Write-Host "5. Sair" -ForegroundColor White
    Write-Host ""
}

# Programa principal
Clear-Host
Write-Host "Iniciando monitorador InfluxDB..." -ForegroundColor Cyan
Write-Host "Configuracao:" -ForegroundColor Gray
Write-Host "  Servidor: $InfluxDB_URL" -ForegroundColor Gray
Write-Host "  Bucket: $InfluxDB_Bucket" -ForegroundColor Gray
Write-Host "  Organizacao: $InfluxDB_Org" -ForegroundColor Gray

# Testar conexão inicial
if (-not (Test-Connection)) {
    Write-Host ""
    Write-Host "Nao foi possivel conectar ao InfluxDB." -ForegroundColor Red
    Write-Host "Verifique as configuracoes e tente novamente." -ForegroundColor Red
    exit 1
}

# Loop do menu
do {
    Show-Menu
    $opcao = Read-Host "Escolha uma opcao (1-5)"
    
    switch ($opcao) {
        "1" {
            Test-Connection
            Write-Host ""
            Read-Host "Pressione Enter para continuar"
        }
        "2" {
            $measurements = List-Measurements
            if ($measurements.Count -gt 0) {
                Write-Host ""
                $measurementName = Read-Host "Digite o nome de uma measurement para detalhes (ou Enter para voltar)"
                if ($measurementName) {
                    Show-Measurement-Details -MeasurementName $measurementName
                    Write-Host ""
                    Read-Host "Pressione Enter para continuar"
                }
            }
        }
        "3" {
            Monitor-Realtime
        }
        "4" {
            Show-APIMapping
            Write-Host ""
            Read-Host "Pressione Enter para continuar"
        }
        "5" {
            Write-Host ""
            Write-Host "Saindo..." -ForegroundColor Yellow
            exit 0
        }
        default {
            Write-Host ""
            Write-Host "Opcao invalida!" -ForegroundColor Red
            Start-Sleep -Seconds 1
        }
    }
} while ($true)