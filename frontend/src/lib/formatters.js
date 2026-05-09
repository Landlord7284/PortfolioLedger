export function applyCurrencyMask(value) {
  if (!value) return "";
  let v = value.replace(/\D/g, "");
  
  // Left pad with 0 to always have at least 3 digits to work with decimals properly
  v = v.padStart(3, "0");
  
  // Extract integer and decimal parts
  const intPart = v.slice(0, -2).replace(/^0+(?=\d)/, ""); // Remove leading zeros from int part, except if it's just "0"
  const decPart = v.slice(-2);
  
  // Format integer part with thousands separators
  const formattedInt = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  
  return `${formattedInt},${decPart}`;
}

export function currencyToBackend(maskedValue) {
  if (!maskedValue) return "0";
  // Remove thousands separators and replace decimal comma with point
  return maskedValue.replace(/\./g, "").replace(",", ".");
}

export function formatMoney(value, hideValues = false) {
  if (hideValues) return "•••••";
  const num = parseFloat(value);
  if (isNaN(num)) return "—";
  return num.toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function getQuantityDecimals(assetClass) {
  switch (assetClass) {
    case 'Tesouro Direto':
    case 'Stock':
    case 'REIT':
      return 2;
    case 'Criptomoeda':
      return 8;
    default:
      return 0;
  }
}

export function formatQuantity(value, assetClass, hideValues = false) {
  if (hideValues) return "•••••";
  const num = parseFloat(value);
  if (isNaN(num)) return "—";
  
  const decimals = getQuantityDecimals(assetClass);
  return num.toLocaleString('pt-BR', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

// Function to handle raw quantity input, restricted by asset class rules
export function sanitizeQuantityInput(value, assetClass) {
  const decimals = getQuantityDecimals(assetClass);
  // Allow only digits and a single comma
  let v = value.replace(/[^\d,]/g, "");
  
  const parts = v.split(",");
  if (parts.length > 2) {
    v = parts[0] + "," + parts.slice(1).join("");
  }
  
  if (decimals === 0) {
    // If no decimals allowed, remove any comma
    v = v.replace(/,/g, "");
  } else if (parts.length > 1) {
    // Limit decimal places
    v = parts[0] + "," + parts[1].slice(0, decimals);
  }
  
  return v;
}
