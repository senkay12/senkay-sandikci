# MSSQL MCP Server

Read-only Model Context Protocol (MCP) server for Microsoft SQL Server. Bu server, local n8n veya diğer MCP istemcileri üzerinden local MSSQL veritabanına güvenli bir şekilde bağlanmanızı sağlar.

## Özellikler

- **Read-Only**: Sadece SELECT sorguları çalıştırılabilir
- **Güvenlik**: INSERT, UPDATE, DELETE, DROP ve diğer yazma işlemleri engellenmiştir
- **Kolay Yapılandırma**: Ortam değişkenleri ile basit yapılandırma
- **MCP Uyumlu**: n8n ve diğer MCP istemcileri ile çalışır

## Kurulum

1. Bağımlılıkları yükleyin:

```bash
npm install
```

2. `.env` dosyası oluşturun (`.env.example` dosyasını örnek alarak):

```bash
cp .env.example .env
```

3. `.env` dosyasını MSSQL bağlantı bilgileriniz ile düzenleyin:

```env
MSSQL_USER=sa
MSSQL_PASSWORD=YourPassword
MSSQL_SERVER=localhost
MSSQL_DATABASE=YourDatabase
MSSQL_PORT=1433
MSSQL_ENCRYPT=false
MSSQL_TRUST_CERT=true
```

4. Projeyi derleyin:

```bash
npm run build
```

## Kullanım

### Doğrudan Çalıştırma

```bash
npm start
```

### n8n ile Kullanım

n8n'in MCP yapılandırma dosyasına ekleyin (genellikle `~/.config/n8n/mcp.json` veya benzeri):

```json
{
  "mcpServers": {
    "mssql": {
      "command": "node",
      "args": ["/path/to/mssql-mcp-server/dist/index.js"],
      "env": {
        "MSSQL_USER": "sa",
        "MSSQL_PASSWORD": "YourPassword",
        "MSSQL_SERVER": "localhost",
        "MSSQL_DATABASE": "YourDatabase",
        "MSSQL_PORT": "1433",
        "MSSQL_ENCRYPT": "false",
        "MSSQL_TRUST_CERT": "true"
      }
    }
  }
}
```

### Claude Desktop ile Kullanım

Claude Desktop yapılandırma dosyasına ekleyin:

**MacOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "mssql": {
      "command": "node",
      "args": ["/absolute/path/to/mssql-mcp-server/dist/index.js"],
      "env": {
        "MSSQL_USER": "sa",
        "MSSQL_PASSWORD": "YourPassword",
        "MSSQL_SERVER": "localhost",
        "MSSQL_DATABASE": "YourDatabase",
        "MSSQL_PORT": "1433",
        "MSSQL_ENCRYPT": "false",
        "MSSQL_TRUST_CERT": "true"
      }
    }
  }
}
```

## Mevcut Araçlar (Tools)

### 1. query_mssql

SQL sorgusu çalıştırır (sadece read-only).

**Parametreler:**
- `query` (string): Çalıştırılacak SQL sorgusu

**Örnek:**
```sql
SELECT * FROM Users WHERE IsActive = 1
```

### 2. list_tables

Veritabanındaki tüm tabloları listeler.

**Parametreler:** Yok

### 3. describe_table

Belirli bir tablonun şemasını gösterir.

**Parametreler:**
- `table_name` (string): İncelenecek tablonun adı

## Güvenlik

Bu server sadece read-only işlemleri destekler. Aşağıdaki komutlar **engellenmiştir**:

- INSERT
- UPDATE
- DELETE
- DROP
- CREATE
- ALTER
- TRUNCATE
- EXEC/EXECUTE
- MERGE
- GRANT/REVOKE/DENY

Herhangi bir yazma işlemi denediğinizde hata alırsınız.

## Geliştirme

```bash
# Geliştirme modunda çalıştırma
npm run dev

# Build
npm run build
```

## Lisans

MIT
