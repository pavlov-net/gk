# Knowledge Extraction Guide

When extracting knowledge from text into the graph, follow these steps:

## 1. Check Existing Graph
Before adding anything, understand what's already there:
- Run `list_entity_types` to see established type conventions
- Run `search_entities` for key names to avoid creating duplicates
- Match existing naming and typing conventions (e.g., if the graph uses
  "Person" don't introduce "person" or "People")

## 2. Identify Entities
- Read the text carefully and identify all named entities
- **Invent types that fit your domain** — there is no fixed vocabulary.
  A literary graph might use Person, Place, Theme; a codebase graph might
  use Module, Function, Pattern; an org graph might use Team, Project, Metric.
- Use the canonical/full name for each entity (e.g., "Jay Gatsby" not just "Gatsby")
- Add relevant properties as key-value pairs

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
