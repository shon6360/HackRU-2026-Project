-- Name normalization used by the fuzzy site matcher: lower-case, expand the abbreviations
-- each system likes, drop legal suffixes and punctuation, collapse whitespace.
CREATE OR REPLACE MACRO norm_name(s) AS trim(regexp_replace(
    regexp_replace(
    regexp_replace(
    regexp_replace(
    regexp_replace(
    regexp_replace(
    regexp_replace(
    regexp_replace(
    regexp_replace(
    regexp_replace(
        replace(lower(s), '&', ' and '),
        '[.,]', ' ', 'g'),
        '\b(llc|inc|pa|p a|foundation|corp|ltd)\b', ' ', 'g'),
        '\bctr\b', 'center', 'g'),
        '\binst\b', 'institute', 'g'),
        '\buniv\b', 'university', 'g'),
        '\bassoc\b', 'associates', 'g'),
        '\brsch\b', 'research', 'g'),
        '\bmed\b', 'medical', 'g'),
        '\bclin\b', 'clinical', 'g'),
    '\s+', ' ', 'g'));
