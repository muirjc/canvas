// VNet + delegated subnets + private DNS zone (canvas-ycu, mirrors ADP's infra/azure/modules/
// network.bicep). One VNet, two delegated subnets: Postgres Flexible Server and the Container
// Apps environment -- so the API container app reaches Postgres privately with NO public
// endpoint on the database at all (replaces docs/azure-deployment.md's old
// --public-access 0.0.0.0-255.255.255.255).

@description('Azure region.')
param location string

@description('VNet name.')
param vnetName string = 'canvas-vnet'

@description('VNet address space.')
param vnetAddressPrefix string = '10.0.0.0/16'

@description('Delegated subnet for the Postgres Flexible Server.')
param postgresSubnetName string = 'postgres-subnet'

@description('Address prefix for the Postgres subnet.')
param postgresSubnetPrefix string = '10.0.1.0/24'

@description('Delegated subnet for the Container Apps environment.')
param containerAppsSubnetName string = 'containerapps-subnet'

@description('Address prefix for the Container Apps subnet -- /23 comfortably clears the workload-profile environment minimum size requirement.')
param containerAppsSubnetPrefix string = '10.0.2.0/23'

@description('Private DNS zone name for Postgres Flexible Server private access. Must match the *.postgres.database.azure.com convention Azure expects.')
param privateDnsZoneName string = 'canvas.private.postgres.database.azure.com'

resource vnet 'Microsoft.Network/virtualNetworks@2025-09-01' = {
  name: vnetName
  location: location
  properties: {
    addressSpace: {
      addressPrefixes: [vnetAddressPrefix]
    }
    subnets: [
      {
        name: postgresSubnetName
        properties: {
          addressPrefix: postgresSubnetPrefix
          delegations: [
            {
              name: 'postgresDelegation'
              properties: {
                serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers'
              }
            }
          ]
        }
      }
      {
        name: containerAppsSubnetName
        properties: {
          addressPrefix: containerAppsSubnetPrefix
          delegations: [
            {
              name: 'containerAppsDelegation'
              properties: {
                serviceName: 'Microsoft.App/environments'
              }
            }
          ]
        }
      }
    ]
  }
}

resource privateDnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: privateDnsZoneName
  location: 'global'
}

resource dnsZoneLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: privateDnsZone
  name: '${vnetName}-link'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnet.id
    }
  }
}

output vnetId string = vnet.id
output vnetName string = vnet.name
output postgresSubnetId string = resourceId('Microsoft.Network/virtualNetworks/subnets', vnetName, postgresSubnetName)
output containerAppsSubnetId string = resourceId('Microsoft.Network/virtualNetworks/subnets', vnetName, containerAppsSubnetName)
output privateDnsZoneId string = privateDnsZone.id
