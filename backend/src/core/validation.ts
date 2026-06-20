export function requireFormFile(formData: FormData, key: string): File {
  const value = formData.get(key);
  if (!value || !(value instanceof File)) {
    throw new Error(`Missing required file field: ${key}`);
  }
  return value;
}

export function requireFormString(formData: FormData, key: string): string {
  const value = formData.get(key);
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing required text field: ${key}`);
  }
  return value;
}
