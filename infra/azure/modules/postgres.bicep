// Azure Database for PostgreSQL Flexible Server (canvas-ycu, mirrors ADP's infra/azure/modules/
// postgres.bicep).
//
// Private/VNet-integrated (no public network access at all) rather than public+firewall -- the
// delegated subnet + private DNS zone are provisioned by modules/network.bicep and passed in.
// This is the key hardening over docs/azure-deployment.md's older path, which opened the server
// to --public-access 0.0.0.0-255.255.255.255 (the entire internet, gated only by password).
//
// Single admin login for both server administration and the app's own connection
// (DATABASE_URL), matching ADP's own precedent (and canvas's docker-compose.yml, which likewise
// uses one `canvas` user for everything). A separate low-privilege app role would need its own
// SQL-execution step this deployment doesn't otherwise require -- ADP's own comment frames this
// as a deliberate simplification, not a best practice to copy uncritically (see canvas-ycu's own
// notes); revisit if this deployment ever needs finer-grained DB access control.

@description('Azure region.')
param location string

@description('Flexible Server name. Must be globally unique.')
param serverName string = 'canvas-postgres'

@description('Postgres major version.')
param postgresVersion string = '16'

@description('Burstable SKU -- cheapest tier, sufficient for a single-environment deployment.')
param skuName string = 'Standard_B1ms'

@description('Storage size in GB (32 is the minimum tier).')
param storageSizeGB int = 32

@description('Admin username.')
param adminUsername string = 'canvas_admin'

@secure()
@description('Admin password. Supplied at deploy time -- never hardcoded/committed.')
param adminPassword string

@description('Delegated subnet resource ID from modules/network.bicep.')
param delegatedSubnetId string

@description('Private DNS zone resource ID from modules/network.bicep.')
param privateDnsZoneId string

@description('Name of the application database to create.')
param databaseName string = 'canvas'

@description('Name of the Keycloak database to create (canvas-ycu.1) -- its own DB on the same server, not sharing the app schema.')
param keycloakDatabaseName string = 'keycloak'

resource server 'Microsoft.DBforPostgreSQL/flexibleServers@2025-08-01' = {
  name: serverName
  location: location
  sku: {
    name: skuName
    tier: 'Burstable'
  }
  properties: {
    version: postgresVersion
    administratorLogin: adminUsername
    administratorLoginPassword: adminPassword
    storage: {
      storageSizeGB: storageSizeGB
    }
    network: {
      delegatedSubnetResourceId: delegatedSubnetId
      privateDnsZoneArmResourceId: privateDnsZoneId
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
  }
}

// Extension allow-list (azure.extensions server parameter). Azure Flexible Server blocks
// `CREATE EXTENSION` for anything not listed here, regardless of DB privileges. canvas's own
// migrations/0001_init.sql runs `CREATE EXTENSION IF NOT EXISTS pgcrypto` (gen_random_uuid() is
// the primary-key default on every table) -- must be listed or the migration job's first run
// fails partway with "extension pgcrypto is not allow-listed" (the exact failure ADP hit on its
// own first Azure run, per its own postgres.bicep comment -- listed here up front to avoid
// rediscovering it).
resource azureExtensions 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2025-08-01' = {
  parent: server
  name: 'azure.extensions'
  properties: {
    value: 'PGCRYPTO'
    source: 'user-override'
  }
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2025-08-01' = {
  parent: server
  name: databaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

resource keycloakDatabase 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2025-08-01' = {
  parent: server
  name: keycloakDatabaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

output serverName string = server.name
output serverFqdn string = server.properties.fullyQualifiedDomainName
output databaseName string = database.name
output keycloakDatabaseName string = keycloakDatabase.name
// canvas expects postgres://user:password@host:5432/db?sslmode=require -- password is
// deliberately NOT interpolated into this output (it's @secure() and this output isn't marked
// secure); deploy.sh assembles the full connection string from this plus the password it already
// holds.
output connectionStringTemplate string = 'postgres://${adminUsername}:<PASSWORD>@${server.properties.fullyQualifiedDomainName}:5432/${database.name}?sslmode=require'
