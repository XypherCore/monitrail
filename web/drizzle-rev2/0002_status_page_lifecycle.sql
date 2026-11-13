-- Custom SQL migration file, put your code below! --
CREATE FUNCTION public.status_page_slug_lifecycle() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
	IF TG_OP = 'UPDATE' THEN
		IF OLD.slug = NEW.slug THEN
			RETURN NEW;
		END IF;
	END IF;

	PERFORM pg_advisory_xact_lock(hashtext('status-page-slug'), 0);

	IF TG_OP <> 'DELETE' THEN
		IF EXISTS (
			SELECT 1 FROM public.slug_tombstones
			WHERE slug = NEW.slug AND released_at > clock_timestamp()
		) THEN
			RAISE EXCEPTION 'Status page slug is unavailable'
				USING ERRCODE = '23514', CONSTRAINT = 'status_pages_slug_available';
		END IF;
	END IF;

	IF TG_OP <> 'INSERT' THEN
		INSERT INTO public.slug_tombstones(slug, released_at)
		VALUES (OLD.slug, clock_timestamp() + interval '720 hours')
		ON CONFLICT (slug) DO UPDATE SET released_at =
			greatest(public.slug_tombstones.released_at, EXCLUDED.released_at);
	END IF;

	IF TG_OP = 'DELETE' THEN
		RETURN OLD;
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER status_page_slug_lifecycle
BEFORE INSERT OR UPDATE OF slug OR DELETE ON public.status_pages
FOR EACH ROW EXECUTE FUNCTION public.status_page_slug_lifecycle();
--> statement-breakpoint
CREATE FUNCTION public.status_page_unpublish_if_empty() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
	-- Lock first so a concurrent deletion on the same page completes
	-- before this transaction reads the remaining links.
	PERFORM 1 FROM public.status_pages
	WHERE id = OLD.status_page_id AND user_id = OLD.user_id
	FOR NO KEY UPDATE;

	IF FOUND THEN
		UPDATE public.status_pages
		SET is_published = false
		WHERE id = OLD.status_page_id AND user_id = OLD.user_id AND is_published
			AND NOT EXISTS (
				SELECT 1 FROM public.status_page_monitors
				WHERE status_page_id = OLD.status_page_id AND user_id = OLD.user_id
			);
	END IF;
	RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER status_page_unpublish_if_empty
AFTER DELETE ON public.status_page_monitors
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.status_page_unpublish_if_empty();
