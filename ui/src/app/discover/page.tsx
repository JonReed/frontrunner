/**
 * /discover — kept only to redirect.
 *
 * This screen was renamed to /found: nothing is discovered here, the scanner
 * already did that. The route stays so that a bookmark, an open tab, or a link
 * in someone's notes does not turn into a 404 after an update.
 */

import { redirect } from 'next/navigation';

export default function DiscoverRedirect() {
  redirect('/found');
}
