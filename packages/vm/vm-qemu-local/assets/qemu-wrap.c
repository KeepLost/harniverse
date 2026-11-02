/*
 * qemu-wrap — supervise one QEMU (or any helper) under host defense-in-depth:
 * rlimits, a Landlock filesystem policy, and a uid/gid drop, then exec.
 *
 * Usage: qemu-wrap --scratch DIR [--must-drop] -- CMD [ARGS...]
 *
 * Policy:
 *   - rlimits: CPU 3600 s, address space 8 GiB, 1024 fds, 256 processes,
 *     1 GiB per file — ceilings, not allocations.
 *   - Landlock: the whole filesystem tree becomes read+execute; only DIR may
 *     be written, created into, or removed from; /dev/kvm (when present) is
 *     additionally read-write for accelerated lanes. Landlock is mandatory:
 *     when the kernel refuses the ruleset the wrapper exits instead of
 *     running an unconfined child.
 *   - uid drop: as root, supplementary groups are cleared and the child runs
 *     as 65534:65534 (nobody). Without root the drop is skipped (or refused
 *     with exit 77 under --must-drop) while Landlock and rlimits still apply.
 *
 * Exit codes: 2 usage/scratch, 3 landlock, 5 uid drop, 77 --must-drop
 * unmet, 127 exec failure.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <linux/landlock.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

#define DROP_UID 65534
#define DROP_GID 65534

static void fail(int code, const char *what) {
  fprintf(stderr, "qemu-wrap: %s: %s\n", what, strerror(errno));
  exit(code);
}

static void add_path_rule(int ruleset_fd, const char *path, uint64_t access) {
  struct landlock_path_beneath_attr attr;
  memset(&attr, 0, sizeof(attr));
  attr.parent_fd = open(path, O_PATH | O_CLOEXEC);
  if (attr.parent_fd < 0) return; /* absent paths are simply not granted */
  attr.allowed_access = access;
  if (syscall(SYS_landlock_add_rule, ruleset_fd, LANDLOCK_RULE_PATH_BENEATH, &attr, 0) != 0)
    fail(3, "landlock_add_rule");
  close(attr.parent_fd);
}

static int open_ruleset(void) {
  int abi = (int)syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 0) fail(3, "landlock unavailable");

  uint64_t handled = LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_WRITE_FILE |
                     LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR |
                     LANDLOCK_ACCESS_FS_REMOVE_DIR | LANDLOCK_ACCESS_FS_REMOVE_FILE |
                     LANDLOCK_ACCESS_FS_MAKE_CHAR | LANDLOCK_ACCESS_FS_MAKE_DIR |
                     LANDLOCK_ACCESS_FS_MAKE_REG | LANDLOCK_ACCESS_FS_MAKE_SOCK |
                     LANDLOCK_ACCESS_FS_MAKE_FIFO | LANDLOCK_ACCESS_FS_MAKE_BLOCK |
                     LANDLOCK_ACCESS_FS_MAKE_SYM;
  if (abi >= 2) handled |= LANDLOCK_ACCESS_FS_REFER;
  if (abi >= 3) handled |= LANDLOCK_ACCESS_FS_TRUNCATE;

  struct landlock_ruleset_attr ruleset;
  memset(&ruleset, 0, sizeof(ruleset));
  ruleset.handled_access_fs = handled;
  int ruleset_fd = (int)syscall(SYS_landlock_create_ruleset, &ruleset, sizeof(ruleset), 0);
  if (ruleset_fd < 0) fail(3, "landlock_create_ruleset");

  /* Whole tree read+execute; TRUNCATE stays denied outside the scratch
   * grant below (QEMU opens its console log with O_TRUNC). */
  add_path_rule(ruleset_fd, "/",
                LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR);
  /* Accelerated lanes need a writable KVM fd; absent nodes are skipped. */
  add_path_rule(ruleset_fd, "/dev/kvm", LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE);
  return ruleset_fd;
}

static void apply_rlimits(void) {
  const struct rlimit limits[] = {
    { 3600, 3600 },              /* RLIMIT_CPU: seconds */
    { 8ULL << 30, 8ULL << 30 },  /* RLIMIT_AS: 8 GiB */
    { 1024, 1024 },              /* RLIMIT_NOFILE */
    { 256, 256 },                /* RLIMIT_NPROC */
    { 1ULL << 30, 1ULL << 30 },  /* RLIMIT_FSIZE: 1 GiB per file */
  };
  const int kinds[] = { RLIMIT_CPU, RLIMIT_AS, RLIMIT_NOFILE, RLIMIT_NPROC, RLIMIT_FSIZE };
  for (size_t i = 0; i < sizeof(kinds) / sizeof(kinds[0]); i++) {
    if (setrlimit(kinds[i], &limits[i]) != 0) fail(2, "setrlimit");
  }
}

int main(int argc, char **argv) {
  const char *scratch = NULL;
  int must_drop = 0;
  int i = 1;
  for (; i < argc; i++) {
    if (strcmp(argv[i], "--scratch") == 0 && i + 1 < argc) {
      scratch = argv[++i];
    } else if (strcmp(argv[i], "--must-drop") == 0) {
      must_drop = 1;
    } else if (strcmp(argv[i], "--") == 0) {
      i++;
      break;
    } else {
      fprintf(stderr, "qemu-wrap: unexpected argument: %s\n", argv[i]);
      return 2;
    }
  }
  if (scratch == NULL || i >= argc) {
    fprintf(stderr, "usage: qemu-wrap --scratch DIR [--must-drop] -- CMD [ARGS...]\n");
    return 2;
  }

  apply_rlimits();

  int ruleset_fd = open_ruleset();
  /* The scratch directory carries every write-side right, including
   * TRUNCATE for the console log. */
  add_path_rule(ruleset_fd, scratch,
                LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR |
                    LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_REMOVE_FILE |
                    LANDLOCK_ACCESS_FS_REMOVE_DIR | LANDLOCK_ACCESS_FS_MAKE_REG |
                    LANDLOCK_ACCESS_FS_MAKE_DIR | LANDLOCK_ACCESS_FS_MAKE_SOCK |
                    LANDLOCK_ACCESS_FS_MAKE_FIFO | LANDLOCK_ACCESS_FS_MAKE_SYM |
                    LANDLOCK_ACCESS_FS_TRUNCATE);
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) fail(3, "PR_SET_NO_NEW_PRIVS");
  if (syscall(SYS_landlock_restrict_self, ruleset_fd, 0) != 0) fail(3, "landlock_restrict_self");
  close(ruleset_fd);

  if (geteuid() == 0) {
    if (setgroups(0, NULL) != 0 || setgid(DROP_GID) != 0 || setuid(DROP_UID) != 0)
      fail(5, "uid drop");
  } else if (must_drop) {
    fprintf(stderr, "qemu-wrap: --must-drop requires root (euid %d)\n", geteuid());
    return 77;
  } else {
    fprintf(stderr, "qemu-wrap: not root; Landlock and rlimits apply, uid drop skipped\n");
  }

  execvp(argv[i], &argv[i]);
  fprintf(stderr, "qemu-wrap: exec %s: %s\n", argv[i], strerror(errno));
  return 127;
}
