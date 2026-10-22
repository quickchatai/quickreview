/*
 * qcr-setid: the always-on bot's way to run the model's tools as the tool uid
 * (D32).
 *
 * The bot runs as its own uid, not root, so a `docker exec` into it lands as
 * that uid, and docker gives a non-root uid no ambient capabilities. This
 * binary carries CAP_SETUID and CAP_SETGID as FILE capabilities, and only the
 * gate group may run it (docker/Dockerfile). It is not setpriv: it can switch
 * to exactly ONE identity, the tool uid and tool gid compiled in below, and
 * nothing else. A copy of setpriv with the same capabilities would let
 * whatever runs as the bot's uid become root (`--reuid=0`), and root inside the
 * container owns the operator channel's seal and the image's own files.
 *
 * It takes setpriv's argv as the engine spells it (src/engine/tooluid.ts
 * setprivSwitches), so the engine is the same whichever binary it starts:
 *
 *   qcr-setid --reuid=<TOOL_UID> --regid=<TOOL_GID> --clear-groups \
 *     --inh-caps=-all --ambient-caps=-all --no-new-privs -- <program> [args...]
 *
 * Every switch is required and every one must say exactly that; any other uid,
 * gid or switch is a refusal (exit 126) before anything changes. Then: no
 * supplementary groups, all three gids and uids the tool's, every capability
 * set emptied (a non-root process keeps a file capability across setuid, so it
 * is dropped by hand), no_new_privs, and the program exec'd.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <grp.h>
#include <linux/capability.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef TOOL_UID
#error "build with -DTOOL_UID=<the tool uid>"
#endif
#ifndef TOOL_GID
#error "build with -DTOOL_GID=<the tool gid>"
#endif
#if TOOL_UID == 0 || TOOL_GID == 0
#error "the tool uid and gid must not be root's"
#endif

#define STR_(x) #x
#define STR(x) STR_(x)

static int refuse(const char *why) {
  fprintf(stderr, "qcr-setid: refused: %s\n", why);
  return 126;
}

static int fail(const char *what) {
  fprintf(stderr, "qcr-setid: %s: %s\n", what, strerror(errno));
  return 126;
}

int main(int argc, char **argv) {
  static const char *const want[] = {
      "--reuid=" STR(TOOL_UID), "--regid=" STR(TOOL_GID), "--clear-groups",
      "--inh-caps=-all",        "--ambient-caps=-all",    "--no-new-privs",
  };
  const int nwant = (int)(sizeof want / sizeof want[0]);
  int seen[sizeof want / sizeof want[0]] = {0};
  int i = 1;
  for (; i < argc && strcmp(argv[i], "--") != 0; i++) {
    int k = 0;
    while (k < nwant && strcmp(argv[i], want[k]) != 0) k++;
    if (k == nwant) return refuse("a switch other than the tool identity's (only uid " STR(TOOL_UID) ", gid " STR(TOOL_GID) ")");
    if (seen[k]++) return refuse("a switch given twice");
  }
  for (int k = 0; k < nwant; k++)
    if (!seen[k]) return refuse("a required switch is missing");
  if (i >= argc - 1) return refuse("no program after --");
  char **prog = argv + i + 1;

  if (setgroups(0, NULL) != 0) return fail("setgroups");
  if (setresgid(TOOL_GID, TOOL_GID, TOOL_GID) != 0) return fail("setresgid");
  if (setresuid(TOOL_UID, TOOL_UID, TOOL_UID) != 0) return fail("setresuid");

  if (prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0) != 0 && errno != EINVAL)
    return fail("clear the ambient capabilities");
  struct __user_cap_header_struct hdr = {_LINUX_CAPABILITY_VERSION_3, 0};
  struct __user_cap_data_struct none[_LINUX_CAPABILITY_U32S_3];
  memset(none, 0, sizeof none);
  if (syscall(SYS_capset, &hdr, none) != 0) return fail("drop the capabilities");
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) return fail("no_new_privs");

  /* Prove the switch before handing over: an identity or a capability left
   * behind is a refusal, never a program run with it. */
  uid_t ru, eu, su;
  gid_t rg, eg, sg;
  struct __user_cap_data_struct now[_LINUX_CAPABILITY_U32S_3];
  if (getresuid(&ru, &eu, &su) != 0 || getresgid(&rg, &eg, &sg) != 0)
    return fail("read back the ids");
  if (ru != TOOL_UID || eu != TOOL_UID || su != TOOL_UID || rg != TOOL_GID ||
      eg != TOOL_GID || sg != TOOL_GID)
    return refuse("the ids did not switch");
  if (getgroups(0, NULL) != 0) return refuse("supplementary groups are left");
  if (syscall(SYS_capget, &hdr, now) != 0) return fail("read back the capabilities");
  for (int k = 0; k < _LINUX_CAPABILITY_U32S_3; k++)
    if (now[k].effective || now[k].permitted || now[k].inheritable)
      return refuse("a capability is left");

  execvp(prog[0], prog);
  return fail(prog[0]);
}
