// The JVM: Gradle (the application plugin's `run`, Spring Boot's `bootRun`)
// and Maven (spring-boot:run, exec:java), with the wrapper when it is there.
import type { RunConfig } from '../config.ts';
import { cwdOf, type Folder, named, type Provider, sourceOf } from './provider.ts';

export const jvm: Provider = {
	name: 'jvm',
	detect(folder: Folder): RunConfig[] {
		const out: RunConfig[] = [];
		const gradleFile = ['build.gradle.kts', 'build.gradle'].find((f) => folder.files.has(f));
		if (gradleFile) {
			const text = folder.read(gradleFile) ?? '';
			const wrapper = folder.up('gradlew');
			const command = wrapper === undefined ? 'gradle' : wrapperPath(folder.rel, wrapper, 'gradlew');
			const add = (task: string) =>
				out.push({ ...named('gradle', folder, task), group: 'Gradle', command, args: [task], ...cwdOf(folder), source: sourceOf(folder, gradleFile) });
			if (/org\.springframework\.boot/.test(text)) add('bootRun');
			if (/\bapplication\b/.test(text)) add('run');
			add('test');
		}
		if (folder.files.has('pom.xml')) {
			const text = folder.read('pom.xml') ?? '';
			const wrapper = folder.up('mvnw');
			const command = wrapper === undefined ? 'mvn' : wrapperPath(folder.rel, wrapper, 'mvnw');
			const add = (goal: string) =>
				out.push({ ...named('maven', folder, goal), group: 'Maven', command, args: [goal], ...cwdOf(folder), source: sourceOf(folder, 'pom.xml') });
			if (/spring-boot-maven-plugin/.test(text)) add('spring-boot:run');
			if (/exec-maven-plugin/.test(text)) add('exec:java');
			add('test');
		}
		return out;
	},
};

/** The wrapper script as cwd (`rel`) sees it: ./gradlew, or ../../gradlew in a subproject. */
function wrapperPath(rel: string, at: string, name: string): string {
	const depth = rel === '' ? 0 : rel.split('/').length;
	const atDepth = at === '' ? 0 : at.split('/').length;
	const ups = depth - atDepth;
	return ups <= 0 ? `./${name}` : `${'../'.repeat(ups)}${name}`;
}
