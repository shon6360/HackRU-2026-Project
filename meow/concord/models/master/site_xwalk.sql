-- @description Site crosswalk: every identifier any source system uses for a site, mapped to the master site key, with the method, a confidence score and the evidence for the match. Systems with a site number match on its digits; systems with only a name (safety, finance) are fuzzy-matched and corroborated by investigator or city.
-- @owner Data Stewardship
-- @grain one row per (source system, native site identifier)
-- @col site_key: Master site key the identifier resolves to; null when unresolved
-- @col system: Source system the identifier comes from
-- @col native_id: Identifier exactly as the source system writes it
-- @col native_label: Human-readable name the source attaches to it, if any
-- @col method: id_pattern, fuzzy_name+investigator or fuzzy_name+city
-- @col confidence: 1.0 for identifier matches; 0.75 x name similarity + 0.25 x corroboration for fuzzy matches
-- @col status: auto (accepted), review (accepted but queued for a data steward) or unresolved
-- @col runner_up_site_key: Second-best candidate for fuzzy matches
-- @col evidence: Plain-language explanation of why this match was made
WITH id_based AS (
    SELECT 'ctms' AS system, site_number_src AS native_id FROM silver.ctms_sites
    UNION SELECT 'ctms', site_number_src FROM silver.ctms_monitoring_visits
    UNION SELECT 'edc', site_id_src FROM silver.edc_subjects
    UNION SELECT 'irt', site_code_src FROM silver.irt_randomizations
    UNION SELECT 'irt', site_code_src FROM silver.irt_kits
),
id_resolved AS (
    SELECT
        s.site_key, i.system, i.native_id,
        s.site_name                                           AS native_label,
        'id_pattern'                                          AS method,
        CASE WHEN s.site_key IS NULL THEN 0.0 ELSE 1.0 END    AS confidence,
        CAST(NULL AS VARCHAR)                                 AS runner_up_site_key,
        CAST(NULL AS DOUBLE)                                  AS runner_up_confidence,
        'trailing digits "' || regexp_extract(i.native_id, '(\d+)$', 1) || '"'
            || CASE WHEN s.site_key IS NULL THEN ' match no site number in the CTMS master'
                    ELSE ' = site number ' || s.site_number END AS evidence
    FROM id_based i
    LEFT JOIN master.site s
           ON s.site_number = TRY_CAST(regexp_extract(i.native_id, '(\d+)$', 1) AS INTEGER)
),
safety_names AS (
    SELECT site_name_src, mode(investigator) AS investigator
    FROM silver.safety_cases GROUP BY 1
),
scored AS (
    SELECT 'safety' AS system, n.site_name_src AS native_id, n.site_name_src AS native_label,
           'fuzzy_name+investigator' AS method, s.site_key, s.site_name,
           norm_name(n.site_name_src) AS norm_src, norm_name(s.site_name) AS norm_master,
           CASE WHEN lower(trim(split_part(n.investigator, ',', 1))) = lower(s.pi_last_name) THEN 1.0 ELSE 0.0 END AS corroboration,
           'investigator ' || n.investigator AS corroboration_label
    FROM safety_names n CROSS JOIN master.site s
    UNION ALL
    SELECT 'finance', v.vendor_id, v.legal_name,
           'fuzzy_name+city', s.site_key, s.site_name,
           norm_name(v.legal_name), norm_name(s.site_name),
           CASE WHEN lower(v.city) = lower(s.city) THEN 1.0 ELSE 0.0 END,
           'city ' || v.city
    FROM silver.finance_vendors v CROSS JOIN master.site s
),
ranked AS (
    SELECT *,
           jaro_winkler_similarity(norm_src, norm_master) AS name_sim,
           round(0.75 * jaro_winkler_similarity(norm_src, norm_master) + 0.25 * corroboration, 3) AS score,
           row_number() OVER (PARTITION BY system, native_id
                              ORDER BY 0.75 * jaro_winkler_similarity(norm_src, norm_master) + 0.25 * corroboration DESC, site_key) AS rk
    FROM scored
),
fuzzy_resolved AS (
    SELECT
        CASE WHEN b.score >= 0.70 THEN b.site_key END AS site_key,
        b.system, b.native_id, b.native_label, b.method,
        b.score                                       AS confidence,
        r.site_key                                    AS runner_up_site_key,
        r.score                                       AS runner_up_confidence,
        '"' || b.norm_src || '" vs master "' || b.norm_master || '": name similarity '
            || printf('%.2f', b.name_sim) || '; ' || b.corroboration_label
            || CASE WHEN b.corroboration = 1 THEN ' matches' ELSE ' does not match' END
            || '; runner-up ' || r.site_key || ' at ' || printf('%.2f', r.score) AS evidence
    FROM ranked b
    LEFT JOIN ranked r ON r.system = b.system AND r.native_id = b.native_id AND r.rk = 2
    WHERE b.rk = 1
),
unioned AS (
    SELECT * FROM id_resolved
    UNION ALL
    SELECT * FROM fuzzy_resolved
)
SELECT
    site_key, system, native_id, native_label, method, confidence,
    CASE WHEN site_key IS NULL THEN 'unresolved'
         WHEN method = 'id_pattern' THEN 'auto'
         WHEN confidence >= 0.85 AND confidence - COALESCE(runner_up_confidence, 0) >= 0.05 THEN 'auto'
         ELSE 'review' END AS status,
    runner_up_site_key, runner_up_confidence, evidence
FROM unioned
