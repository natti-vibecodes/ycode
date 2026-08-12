/**
 * Structural divergence: pages carrying their own COPY of a section that other pages get from a
 * component (SCA-1272).
 *
 * This is the failure that cost us a shipped fix. `/services/web-app-development` was cloned from
 * `/services/design-branding` BEFORE the newsletter section was turned into a component, so it
 * kept a private copy. Fixing the component reached every page except that one — and nothing
 * anywhere reported it: the publish queue was clean, the component said published, the page said
 * published, and the served page was quietly a version behind.
 *
 * It is invisible precisely because every individual signal is healthy. The only way to see it is
 * to ask a different question: which pages *look like* they contain this section, but are not
 * actually instances of it?
 *
 * Detection is by class signature. A component's layers carry distinctive custom classes
 * (`nl-form`, `ct-form`, `twl-tile`); a page holding several of those without an instance of the
 * component is holding a copy. Deliberately a heuristic — it reports suspects for a human to
 * confirm, and is tuned to avoid crying wolf: a single shared utility class is not evidence,
 * which is why a match threshold exists.
 */

export interface DivergenceLayer {
  id: string;
  componentId?: string | null;
  settings?: { customAttributes?: Record<string, string> | null } | null;
  children?: DivergenceLayer[] | null;
}

export interface DivergenceComponent {
  id: string;
  name: string;
  layers: DivergenceLayer[];
}

export interface DivergencePage {
  id: string;
  name: string;
  layers: DivergenceLayer[];
}

export interface DivergenceFinding {
  componentId: string;
  componentName: string;
  pageId: string;
  pageName: string;
  /** Signature classes found on the page while it holds no instance of the component. */
  matchedClasses: string[];
}

/**
 * Classes too generic to identify a section. A page sharing these with a component means nothing —
 * they are layout primitives that appear everywhere.
 */
const GENERIC = new Set([
  'sec', 'row', 'col', 'grid', 'wrap', 'inner', 'container', 'reveal', 'in',
  'kick', 'cta-zone', 'cta2', 'cl', 'cl-i', 'ca', 'btn', 'field', 'span2',
  // Link/decoration utilities. Added after the first live run: two pages were reported as
  // copies of "Statement band" purely because they contained `tlink` + `arrow`, which appear
  // on ordinary links across the whole site. A scan that cries wolf is a scan nobody runs.
  'tlink', 'arrow', 'lite-u', 'soc-ic', 'num', 'stars', 'rlbl',
]);

function classesOf(layer: DivergenceLayer): string[] {
  const raw = layer.settings?.customAttributes?.class;
  if (!raw) return [];
  return raw.split(/\s+/).filter(Boolean);
}

function walk(layers: DivergenceLayer[] | null | undefined, visit: (l: DivergenceLayer) => void): void {
  for (const layer of layers ?? []) {
    visit(layer);
    walk(layer.children, visit);
  }
}

/** Distinctive classes that identify a component's markup. */
export function signatureClasses(component: DivergenceComponent): Set<string> {
  const found = new Set<string>();
  walk(component.layers, (l) => {
    for (const c of classesOf(l)) {
      if (!GENERIC.has(c)) found.add(c);
    }
  });
  return found;
}

/**
 * Report pages that appear to hold a copy of a component's section without being an instance.
 *
 * `minMatches` is the number of distinct signature classes a page must show before it is called
 * a copy. Two is enough to be specific (`nl-form` + `nl-zone`) while ignoring incidental overlap.
 */
export function findStructuralDivergence(
  components: DivergenceComponent[],
  pages: DivergencePage[],
  minMatches = 2,
): DivergenceFinding[] {
  const findings: DivergenceFinding[] = [];

  for (const component of components) {
    const signature = signatureClasses(component);
    if (signature.size < minMatches) continue; // too generic to judge

    for (const page of pages) {
      let usesComponent = false;
      const matched = new Set<string>();

      walk(page.layers, (l) => {
        if (l.componentId === component.id) usesComponent = true;
        for (const c of classesOf(l)) if (signature.has(c)) matched.add(c);
      });

      // An instance means the page is wired correctly — a copy elsewhere on the same page is a
      // different problem, and flagging it here would bury the signal we care about.
      if (usesComponent) continue;
      if (matched.size < minMatches) continue;

      findings.push({
        componentId: component.id,
        componentName: component.name,
        pageId: page.id,
        pageName: page.name,
        matchedClasses: [...matched].sort(),
      });
    }
  }

  return findings;
}
