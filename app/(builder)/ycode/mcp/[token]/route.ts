import { NextRequest } from 'next/server';
import {
  authenticateToken,
  handleMcpPost,
  handleMcpGet,
  handleMcpDelete,
  addCorsHeaders,
  unauthorizedJson,
} from '@/lib/mcp/handler';
import { normalizeScopes } from '@/lib/mcp/scopes';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Legacy URL-token MCP endpoint.
 *
 * Used by Cursor, Windsurf, Claude Desktop, and Claude Code — clients that
 * accept an MCP URL with the auth token embedded in the path. Claude.ai web
 * and ChatGPT use the sibling `/ycode/mcp` route, which authenticates via
 * `Authorization: Bearer <token>` headers issued by the OAuth flow.
 */

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const record = await authenticateToken(token);
  if (!record) {
    return unauthorizedJson('Invalid MCP token');
  }
  // The token's scopes decide which tool groups this session even sees (SCA-1233).
  // NULL scopes means an unscoped legacy token: full access, unchanged.
  return handleMcpPost(request, normalizeScopes(record.scopes));
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const record = await authenticateToken(token);
  if (!record) {
    return unauthorizedJson('Invalid MCP token');
  }
  // The token's scopes decide which tool groups this session even sees (SCA-1233).
  // NULL scopes means an unscoped legacy token: full access, unchanged.
  return handleMcpGet(request, normalizeScopes(record.scopes));
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const record = await authenticateToken(token);
  if (!record) {
    return unauthorizedJson('Invalid MCP token');
  }
  // The token's scopes decide which tool groups this session even sees (SCA-1233).
  // NULL scopes means an unscoped legacy token: full access, unchanged.
  return handleMcpDelete(request, normalizeScopes(record.scopes));
}

export async function OPTIONS() {
  return addCorsHeaders(new Response(null, { status: 204 }));
}
