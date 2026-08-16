/**
 * Model catalog views for the terminal UI: a thin projection over the LLM
 * provider/model surface, shared by the model picker and the header.
 */

/** One selectable model inside a provider group (mirrors the web catalog slice). */
export interface ModelProviderGroup {
  id: string
  name: string
  models: { id: string; name: string }[]
}

/**
 * Fold provider listings + model listings into one picker projection.
 * @param providers - the registered provider routes.
 * @param modelsByProvider - advertised models keyed by provider id.
 * @returns the picker groups in provider order.
 */
export function buildModelGroups(
  providers: readonly { id: string; name: string }[],
  modelsByProvider: ReadonlyMap<string, { id: string; name: string }[]>,
): ModelProviderGroup[] {
  return providers.map(provider => ({
    id: provider.id,
    name: provider.name,
    models: modelsByProvider.get(provider.id) ?? [],
  }))
}
