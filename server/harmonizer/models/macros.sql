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

-- SDTM dates are ISO 8601 and stop early when the day or the month was not collected:
-- '2013-06-14', '2013-06' or '2013'. iso_date_precision says how much of the date there is
-- ('day', 'month', 'year', or NULL when it is not a date at all), and iso_date_start is the
-- first day the value can mean, so an event with a partial date still sorts and filters by date.
CREATE OR REPLACE MACRO iso_date_precision(s) AS CASE
    WHEN TRY_CAST(s AS DATE) IS NOT NULL THEN 'day'
    WHEN regexp_full_match(trim(s), '\d{4}-\d{2}') AND TRY_CAST(trim(s) || '-01' AS DATE) IS NOT NULL THEN 'month'
    WHEN regexp_full_match(trim(s), '\d{4}') AND TRY_CAST(trim(s) || '-01-01' AS DATE) IS NOT NULL THEN 'year' END;

CREATE OR REPLACE MACRO iso_date_start(s) AS CASE iso_date_precision(s)
    WHEN 'day' THEN TRY_CAST(s AS DATE)
    WHEN 'month' THEN TRY_CAST(trim(s) || '-01' AS DATE)
    WHEN 'year' THEN TRY_CAST(trim(s) || '-01-01' AS DATE) END;
