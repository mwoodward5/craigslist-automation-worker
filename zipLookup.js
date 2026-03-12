// ArcGIS US Craigslist Zip Codes dataset
// 33144 zip codes mapped to CL subdomains
// Source: https://www.arcgis.com/home/item.html?id=060e53d434f345509607feb9ca418fe5

const path = require('path');
const ZIP_TO_CL = require('./zip-to-cl.json');

/**
 * Given a 5-digit zip code, returns the CL subdomain it belongs to.
 * e.g. '90802' -> 'losangeles', '92612' -> 'orangecounty', '94102' -> 'sfbay'
 */
function getClSubdomainForZip(zip) {
  if (!zip) return null;
  const clean = String(zip).trim().substring(0, 5);
  return ZIP_TO_CL[clean] || null;
}

/**
 * Check if a zip code belongs to the expected CL city subdomain.
 * Returns { valid: true/false, actualCity: string|null }
 */
function validateZipForCity(zip, expectedSubdomain) {
  const actual = getClSubdomainForZip(zip);
  if (!actual) return { valid: true, actualCity: null }; // unknown zip, allow it
  return {
    valid: actual === expectedSubdomain,
    actualCity: actual
  };
}

module.exports = { getClSubdomainForZip, validateZipForCity, ZIP_TO_CL };
