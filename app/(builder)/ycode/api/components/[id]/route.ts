import { NextRequest, NextResponse } from 'next/server';
import { isConflictError } from '@/lib/errors/conflict';
import {
  getComponentById,
  updateComponent,
  softDeleteComponent,
  restoreComponent,
  findEntitiesUsingComponent,
} from '@/lib/repositories/componentRepository';

/**
 * GET /ycode/api/components/[id]
 * Get a single component by ID
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const component = await getComponentById(id);

    if (!component) {
      return NextResponse.json({ error: 'Component not found' }, { status: 404 });
    }

    return NextResponse.json({ data: component });
  } catch (error) {
    console.error('Error fetching component:', error);
    return NextResponse.json(
      { error: 'Failed to fetch component' },
      { status: 500 }
    );
  }
}

/**
 * PUT /ycode/api/components/[id]
 * Update a component (triggers sync across all instances)
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { name, layers, variables, variants, base_content_hash: baseContentHash } = body;

    const updates: any = {};
    if (name !== undefined) updates.name = name;
    if (layers !== undefined) updates.layers = layers;
    if (variables !== undefined) updates.variables = variables;
    if (variants !== undefined) updates.variants = variants;

    // The builder sends the `content_hash` it loaded the component at. Without it this PUT is a
    // blind whole-tree replace that silently erases anything MCP (or another tab) wrote since —
    // that is how the third form's honeypot was lost (SCA-1476). Absent hash = old behaviour.
    const component = await updateComponent(id, updates, { baseContentHash });

    return NextResponse.json({ data: component });
  } catch (error) {
    if (isConflictError(error)) {
      // 409, not 500: the write was REFUSED and the stored tree is intact. The body carries the
      // current component so the client can reload it instead of retrying its stale payload.
      return NextResponse.json(
        {
          error:
            'This component changed since you opened it — reload to see the latest.',
          code: 'conflict',
          key: error.key,
          expected_content_hash: error.expected,
          current: error.current,
        },
        { status: 409 }
      );
    }
    console.error('Error updating component:', error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to update component';
    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    );
  }
}

/**
 * DELETE /ycode/api/components/[id]
 * Soft delete a component and detach it from all instances
 * Returns the deleted component and affected entities for undo/redo
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // Soft delete the component and get affected entities
    const result = await softDeleteComponent(id);

    return NextResponse.json({
      data: {
        component: result.component,
        affectedEntities: result.affectedEntities,
      },
      message: 'Component deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting component:', error);
    return NextResponse.json(
      { error: 'Failed to delete component' },
      { status: 500 }
    );
  }
}

/**
 * PATCH /ycode/api/components/[id]
 * Restore a soft-deleted component or get affected entities preview
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();

    // Check if this is a restore request
    if (body.action === 'restore') {
      const component = await restoreComponent(id);
      return NextResponse.json({ data: component });
    }

    // Check if this is a preview request (get affected entities without deleting)
    if (body.action === 'preview-delete') {
      const affectedEntities = await findEntitiesUsingComponent(id);
      return NextResponse.json({
        data: {
          affectedCount: affectedEntities.length,
          affectedEntities: affectedEntities.map(e => ({
            type: e.type,
            id: e.id,
            name: e.name,
            pageId: e.pageId,
          })),
        },
      });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (error) {
    console.error('Error processing component action:', error);
    return NextResponse.json(
      { error: 'Failed to process request' },
      { status: 500 }
    );
  }
}
