# Knowledge Extraction Guide

When extracting knowledge from text into the graph, follow these steps:

## 1. Check Existing Graph
Before adding anything, understand what's already there:
- Run `list_entity_types` to see established type conventions
- Run `search_entities` for key names to avoid creating duplicates
- Match existing naming and typing conventions (e.g., if the graph uses
  "Person" don't introduce "person" or "People")

## 2. Identify Entities
- Read the text carefully and identify all significant entities — named or unnamed.
  Entities don't require proper names; a descriptive name is fine (e.g.,
  "Rate Limiter Module", "Q3 Budget Meeting", "The Lighthouse").
- **Prefer more entities over fewer.** An entity that appears in only one passage
  is still worth capturing if it's distinct enough to have its own properties
  or relationships.
- **Invent types that fit your domain** — there is no fixed vocabulary.
  A literary graph might use Person, Place, Theme; a codebase graph might
  use Module, Function, Pattern; an org graph might use Team, Project, Metric.
- Use the canonical/full name for each entity (e.g., "Jay Gatsby" not just "Gatsby")
- Add relevant properties as key-value pairs

### Completeness Sweep
After your initial entity identification, run these four checks before moving
to relationships:

1. **Type coverage**: Review your entity types. If a type has very few instances
   compared to others, re-read the source looking for missed members of that type.
2. **Section coverage**: Walk through each section/chunk of the source material.
   If any section produced zero entities, re-read it — something was likely missed.
3. **Implicit entities**: Check whether any relationships or observations reference
   things that aren't yet entities. If an observation mentions a location, concept,
   or actor that doesn't have its own entity, create one.
4. **Relationship-driven discovery**: After drafting relationships, check for implied
   entities. If you want to write "X LOCATED_IN ???" or "X DEPENDS_ON ???" but the
   target doesn't exist, that's a missing entity.

## 3. Identify Relationships
- Find how entities relate to each other in the text
- **Invent relationship types that fit your domain** — use clear, uppercase
  names (KNOWS, DEPENDS_ON, IMPLEMENTS, LOCATED_IN, etc.)
- Add directional relationships: source → type → target
- Include properties on relationships when relevant (e.g., since, role)

## 4. Create Observations
- Extract key facts, quotes, and descriptions as observations
- Link each observation to ALL relevant entities
- Use metadata to track source (e.g., {"chapter": "3", "page": "42"})
- Set confidence (0-1) if the information quality varies
- Set provenance to track where the information came from

## 5. Review
- Use validate_graph to check for quality issues
- Use merge_entities to consolidate any duplicates
- Ensure entities have both relationships AND observations

## Tips
- Build entities first, then relationships, then observations
- Use search_entities to check if an entity already exists before creating
- Be consistent with naming and typing conventions across the graph
