-- Phase 2.2: Centralized Document Sequence Engine - Configurable Padding
-- Strictly additive migration: adds paddingZeros column with non-null default of 5
ALTER TABLE "DocumentNumberSequence"
ADD COLUMN IF NOT EXISTS "paddingZeros" SMALLINT NOT NULL DEFAULT 5;
