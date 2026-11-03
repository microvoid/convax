/** Resolve documentation links across content roots inside one Git repository. */
import { realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { TranslationLinkContext } from './translation-links.ts'
import type { TranslationPairPaths } from './translation-pairing-record.ts'
import { isTranslationScopeFile } from './translation-pairing.ts'

/** Repository-relative link inputs with content-root scanning and exclusions. */
export interface TranslationRepositoryContext {
  /** Link resolution inputs independent of a particular source document. */
  readonly record: Omit<TranslationLinkContext, 'sourcePath'>
  /** Convert a complete content-relative pair to repository-relative paths. */
  readonly pairPaths: (paths: TranslationPairPaths) => TranslationPairPaths
  /** Resolve links from one content-relative document. */
  readonly source: (path: string) => TranslationLinkContext
}

/**
 * Keep a nested documentation corpus inside its enclosing repository's link scope.
 * @param contentRoot - Existing directory whose scanner owns the current corpus.
 * @param repositoryRoot - Existing enclosing Git repository directory.
 * @param isContentPairSource - Corpus predicate including that content root's exclusions.
 * @param contentFileExists - File lookup accepting paths relative to contentRoot.
 * @returns Link and record inputs that also recognize sibling package README pairs.
 * @throws When a requested source document is outside the enclosing repository.
 */
export function translationRepositoryContext(
  contentRoot: string, repositoryRoot: string,
  isContentPairSource: (path: string) => boolean,
  contentFileExists: (path: string) => boolean,
): TranslationRepositoryContext {
  const content = realpathSync(contentRoot)
  const repository = realpathSync(repositoryRoot)
  const outside = (path: string): boolean => path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)
  const repositoryPath = (path: string): string => {
    const relativePath = relative(repository, resolve(content, path))
    if (outside(relativePath)) throw new Error(`${path} is outside the documentation Git repository`)
    return relativePath.split(sep).join('/')
  }
  const contentPath = (path: string): string => relative(content, resolve(repository, path)).split(sep).join('/')
  const record: TranslationRepositoryContext['record'] = {
    repoRoot: repository,
    semanticRoot: content,
    isTranslationPairSource: (path) => {
      const local = contentPath(path)
      return local === '..' || local.startsWith('../') ? isTranslationScopeFile(path) : isContentPairSource(local)
    },
    repositoryFileExists: path => contentFileExists(contentPath(path)),
  }
  return {
    record,
    pairPaths: paths => ({ source: repositoryPath(paths.source), zh: repositoryPath(paths.zh), meta: repositoryPath(paths.meta) }),
    source: path => ({ ...record, sourcePath: repositoryPath(path) }),
  }
}
