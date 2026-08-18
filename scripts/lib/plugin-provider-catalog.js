import { readFileSync } from 'node:fs';
import path from 'node:path';

import { validateJsonAgainstSchema } from './schema-validation.js';

const rootDir = path.resolve(import.meta.dirname, '..', '..');
const catalogPath = path.join(rootDir, 'manifests', 'plugin-providers.json');
const schemaPath = path.join(rootDir, 'schemas', 'plugin-provider-catalog.schema.json');
const catalogSchema = JSON.parse(readFileSync(schemaPath, 'utf8'));

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

export function validatePluginProviderCatalog(catalog, { moduleIds, provisioningToolIds } = {}) {
  const errors = validateJsonAgainstSchema(catalog, catalogSchema, 'plugin-providers');
  if (errors.length > 0) return errors;

  const capabilityIds = new Set();
  for (const capability of catalog.capabilities) {
    if (capabilityIds.has(capability.id)) errors.push('Duplicate capability id: ' + capability.id);
    capabilityIds.add(capability.id);
  }

  const providerIds = new Set();
  const aliases = new Set();
  const toolIds = new Set();
  for (const provider of catalog.providers) {
    if (providerIds.has(provider.id)) errors.push('Duplicate provider id: ' + provider.id);
    providerIds.add(provider.id);
    if (!provider.aliases.includes(provider.cliName)) {
      errors.push('Provider ' + provider.id + ' aliases must include cliName ' + provider.cliName);
    }
    for (const alias of provider.aliases) {
      if (aliases.has(alias)) errors.push('Duplicate provider alias: ' + alias);
      aliases.add(alias);
    }
    for (const capabilityId of provider.capabilities) {
      if (!capabilityIds.has(capabilityId)) {
        errors.push('Provider ' + provider.id + ' references unknown capability: ' + capabilityId);
      }
    }
    if (provider.selection.includeInAll && !provider.selection.allowInProjectConfig) {
      errors.push('Provider ' + provider.id + ' cannot be included in all while disabled for project config');
    }
    if (provider.provisioningToolId) {
      if (toolIds.has(provider.provisioningToolId)) {
        errors.push('Duplicate provisioning tool id: ' + provider.provisioningToolId);
      }
      toolIds.add(provider.provisioningToolId);
    }
    if (moduleIds && !moduleIds.has(provider.moduleId)) {
      errors.push('Provider ' + provider.id + ' references unknown module: ' + provider.moduleId);
    }
    if (provisioningToolIds && provider.provisioningToolId && !provisioningToolIds.has(provider.provisioningToolId)) {
      errors.push('Provider ' + provider.id + ' references unknown provisioning tool: ' + provider.provisioningToolId);
    }
  }

  const providerById = new Map(catalog.providers.map((provider) => [provider.id, provider]));
  for (const provider of catalog.providers) {
    for (const conflictId of provider.conflicts ?? []) {
      const conflict = providerById.get(conflictId);
      if (!conflict) {
        errors.push('Provider ' + provider.id + ' conflicts with unknown provider: ' + conflictId);
      } else if (!(conflict.conflicts ?? []).includes(provider.id)) {
        errors.push('Provider conflict must be symmetric: ' + provider.id + ' -> ' + conflictId);
      }
    }
  }

  if (provisioningToolIds) {
    for (const toolId of provisioningToolIds) {
      if (!toolIds.has(toolId)) errors.push('Provisioning tool has no provider: ' + toolId);
    }
  }
  return errors;
}

export function assertPluginProviderCatalog(catalog, options) {
  const errors = validatePluginProviderCatalog(catalog, options);
  if (errors.length > 0) throw new Error('Invalid plugin provider catalog:\n' + errors.join('\n'));
}

const loadedCatalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
assertPluginProviderCatalog(loadedCatalog);

export const pluginProviderCatalog = deepFreeze(loadedCatalog);
export const pluginProviders = pluginProviderCatalog.providers;

const providerByAlias = new Map(pluginProviders.flatMap((provider) => provider.aliases.map((alias) => [alias, provider])));
const providerById = new Map(pluginProviders.map((provider) => [provider.id, provider]));
const providerByModuleId = new Map(pluginProviders.map((provider) => [provider.moduleId, provider]));
const providerByToolId = new Map(pluginProviders
  .filter((provider) => provider.provisioningToolId)
  .map((provider) => [provider.provisioningToolId, provider]));

export function pluginProviderForAlias(alias) {
  return providerByAlias.get(alias) ?? null;
}

export function pluginProviderForId(providerId) {
  return providerById.get(providerId) ?? null;
}

export function pluginProviderForModule(moduleId) {
  return providerByModuleId.get(moduleId) ?? null;
}

export function pluginProviderForTool(toolId) {
  return providerByToolId.get(toolId) ?? null;
}

export function selectedPluginProviders(moduleIds) {
  const selected = new Set(moduleIds ?? []);
  return pluginProviders.filter((provider) => selected.has(provider.moduleId));
}

export function hasPluginCapability(moduleIds, capabilityId) {
  return selectedPluginProviders(moduleIds).some((provider) => provider.capabilities.includes(capabilityId));
}
