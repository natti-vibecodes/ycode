/**
 * MCP Server Factory
 *
 * Creates a new McpServer instance with all tools and resources registered.
 * Each HTTP session gets its own server instance.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { hasScope, type McpScope } from '@/lib/mcp/scopes';
import { DEFERRED_GROUP_GUIDES, MCP_PUBLISHING_INSTRUCTIONS, SYSTEM_INSTRUCTIONS } from '@/lib/mcp/instructions';
import { registerPageTools } from '@/lib/mcp/tools/pages';
import { registerPageFolderTools } from '@/lib/mcp/tools/page-folders';
import { registerLayerTools } from '@/lib/mcp/tools/layers';
import { registerBatchTools } from '@/lib/mcp/tools/batch';
import { registerLayoutTools } from '@/lib/mcp/tools/layouts';
import { registerCollectionTools } from '@/lib/mcp/tools/collections';
import { registerCollectionLayerTools } from '@/lib/mcp/tools/collection-layers';
import { registerStyleTools } from '@/lib/mcp/tools/styles';
import { registerAssetTools } from '@/lib/mcp/tools/assets';
import { registerAssetFolderTools } from '@/lib/mcp/tools/asset-folders';
import { registerComponentTools } from '@/lib/mcp/tools/components';
import { registerColorVariableTools } from '@/lib/mcp/tools/color-variables';
import { registerFontTools } from '@/lib/mcp/tools/fonts';
import { registerLocaleTools } from '@/lib/mcp/tools/locales';
import { registerFormTools } from '@/lib/mcp/tools/forms';
import { registerSettingsTools } from '@/lib/mcp/tools/settings';
import { registerPublishingTools } from '@/lib/mcp/tools/publishing';
import { registerAnimationTools } from '@/lib/mcp/tools/animations';
import { registerReferenceResources } from '@/lib/mcp/resources/reference';
import { registerSiteResources } from '@/lib/mcp/resources/site';

export function createMcpServer(scopes: McpScope[] | null = null): McpServer {
  // NULL scopes = every scope, which is what keeps existing tokens working untouched while
  // least privilege is adopted by minting new scoped tokens (SCA-1233). Tools a token cannot
  // use are never REGISTERED, so they do not appear in tools/list either — an agent should not
  // be shown capabilities it will only be refused.
  const allow = (scope: McpScope) => hasScope(scopes, scope);
  // External MCP agents get every tool up front, so they also get the full
  // deferred-group guides plus the publishing instructions. The in-app agent
  // runtime uses SYSTEM_INSTRUCTIONS alone, delivers group guides via
  // load_tools, and appends its own draft-first (never publish) policy instead.
  const server = new McpServer(
    { name: 'ycode', version: '1.0.0' },
    { instructions: SYSTEM_INSTRUCTIONS + '\n' + Object.values(DEFERRED_GROUP_GUIDES).join('\n\n') + MCP_PUBLISHING_INSTRUCTIONS },
  );

  if (allow('pages')) registerPageTools(server);
  if (allow('pages')) registerPageFolderTools(server);
  if (allow('layers')) registerLayerTools(server);
  if (allow('layers')) registerBatchTools(server);
  if (allow('layers')) registerLayoutTools(server);
  if (allow('collections')) registerCollectionTools(server);
  if (allow('collections')) registerCollectionLayerTools(server);
  if (allow('styles')) registerStyleTools(server);
  if (allow('assets')) registerAssetTools(server);
  if (allow('assets')) registerAssetFolderTools(server);
  if (allow('components')) registerComponentTools(server);
  if (allow('styles')) registerColorVariableTools(server);
  if (allow('styles')) registerFontTools(server);
  if (allow('locales')) registerLocaleTools(server);
  if (allow('forms')) registerFormTools(server);
  if (allow('settings')) registerSettingsTools(server);
  if (allow('publishing')) registerPublishingTools(server);
  if (allow('animations')) registerAnimationTools(server);

  registerReferenceResources(server);
  registerSiteResources(server);

  return server;
}
