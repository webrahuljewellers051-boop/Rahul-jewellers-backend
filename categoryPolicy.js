// Jewellery category safety rules

export const MAIN_JEWELLERY_CATEGORIES = Object.freeze([
  'Gold',
  'Polki',
  'Kundan',
  'Diamond',
  'Silver'
]);

export function mainCategoryName(name) {
  const normalized = String(name ?? '')
    .trim()
    .toLowerCase();

  return MAIN_JEWELLERY_CATEGORIES.find(
    item => item.toLowerCase() === normalized
  ) || null;
}

export function isProtectedRoot(category) {
  return Boolean(
    category &&
    !category.parentCategory &&
    mainCategoryName(category.name)
  );
}

export function canMoveBetweenRoots(
  sourceRootName,
  destinationRootName
) {
  const destination = mainCategoryName(destinationRootName);

  if (!destination) return false;

  const source = mainCategoryName(sourceRootName);

  return !source || source === destination;
}