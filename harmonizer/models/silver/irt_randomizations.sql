-- @description Randomization list from IRT, typed. Contains the real treatment assignment.
-- @owner Clinical Supply Chain
-- @tags patient_level
-- @grain one row per randomization
-- @col rand_no: Randomization number
-- @col subject_no_src: Subject exactly as IRT writes it: site and subject number run together, e.g. 7011015
-- @col site_code_src: Site exactly as IRT writes it, e.g. US701
-- @col randomization_date: Date of randomization (source format DDMONYYYY)
-- @col arm_code [unblinded]: Treatment code A / B / C
-- @col arm [unblinded]: Treatment description
SELECT
    rand_no,
    subject_no                                       AS subject_no_src,
    site                                             AS site_code_src,
    CAST(TRY_STRPTIME(rand_dt, '%d%b%Y') AS DATE)    AS randomization_date,
    trt_cd                                           AS arm_code,
    trt_desc                                         AS arm,
    stratum,
    study                                            AS study_id_src,
    _src_system, _src_file, _src_row
FROM bronze.irt_randomization
