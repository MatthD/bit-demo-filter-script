import { exec as execCb } from "child_process";
import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { resolve } from "path";
import { promisify } from "util";
import { homedir } from "os";
import { program } from "commander";
import chalk from "chalk";
import { parse } from "jsonc-parser";

const exec = promisify(execCb);

type DepsObj = {
  id: string;
  version: string;
  lifecycle: "dev" | "runtime";
  source: string;
};

const processedPackages = new Set<string>();

const getDeps = async (
  bitpath: string,
  packageName: string,
  listOfNeededDeps: Record<string, string> = {},
): Promise<Record<string, string>> => {
  if (processedPackages.has(packageName)) {
    console.log(
      chalk.cyan(
        `Package ${packageName} has already been processed, skipping.`,
      ),
    );
    return listOfNeededDeps;
  }

  console.log(chalk.green(`Fetching dependencies for package: ${packageName}`));
  const { stdout } = await exec(`${bitpath} show ${packageName} --json`);
  const parsedJson = JSON.parse(stdout);
  const dependencies: DepsObj[] =
    parsedJson.find((key: any) => key.title === "dependencies")?.json || [];

  const notDevDeps = dependencies.filter((dep) => dep.lifecycle === "runtime");
  // Those packages are local packages sont we need to get their own deps too, because used by the current apps
  const avaPackagesLinked = notDevDeps
    .filter(
      (dep) => dep.id.includes("superorg/") && !dep.id.includes("contracts"),
    )
    .map((dep) => dep.id.split("superorg/")[1]);

  const depsWithoutAvaPackage = notDevDeps
    .filter((dep) => !dep.id.includes("superorg/"))
    .reduce((acc, current) => ({ ...acc, [current.id]: current.version }), {});

  listOfNeededDeps = { ...listOfNeededDeps, ...depsWithoutAvaPackage };

  processedPackages.add(packageName);

  for (const dep of avaPackagesLinked) {
    console.log(chalk.blue(`Fetching dependencies for Ava package: ${dep}`));
    listOfNeededDeps = await getDeps(bitpath, dep, listOfNeededDeps);
  }

  return listOfNeededDeps;
};

program
  .requiredOption("-p, --package <string>", "package name: api|room|core|..")
  .option(
    "-f, --outputfile <string>",
    "json file to modify",
    "../workspace.jsonc",
  )
  .option("-b, --bitbinpath <string>", "path to bit bin");

program.parse(process.argv);

const options =
  program.opts<Record<"outputfile" | "package" | "bitbinpath", string>>();

if (options.bitbinpath && !existsSync(options.bitbinpath)) {
  console.error(chalk.red(`Bin Bit not found : ${options.bitbinpath}`));
  process.exit(1);
}

const bitpath = options.bitbinpath ?? resolve(homedir(), "bin/bit");
console.log(
  chalk.yellow(`Starting dependency fetch for package: ${options.package}`),
);

getDeps(bitpath, options.package)
  .then(async (listOfNeededDeps) => {
    console.log(chalk.yellow(`Modifying file: ${options.outputfile}`));
    const listOfWantedDeps = Object.keys(listOfNeededDeps);
    const filePath = resolve(__dirname, options.outputfile);
    const fileContent = parse(await readFile(filePath, "utf8"));
    const depsFileRef = fileContent["teambit.dependencies/dependency-resolver"]
      .policy.dependencies as Record<string, string>;
    // ? this is a trick because bit show does not return aliases, so we need to keep all aliases modules
    for (const depName in depsFileRef) {
      const versionPattern = /^\d+\.\d+\.\d+$/;
      if (
        !listOfWantedDeps.includes(depName) &&
        versionPattern.test(depsFileRef[depName])
      ) {
        delete depsFileRef[depName];
      }
    }

    await writeFile(filePath, JSON.stringify(fileContent, null, 4), "utf8");
  })
  .then(() =>
    console.log(
      chalk.green(`File ${options.outputfile} successfully modified`),
    ),
  )
  .catch((error) => console.error(chalk.red(`Error: ${error.message}`)));
